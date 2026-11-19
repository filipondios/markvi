// Copia de seguridad de los borradores sin guardar en `localStorage`.
//
// Lo escrito en el editor solo vive en memoria hasta `:w`: si el navegador se cierra,
// la pestaña se recarga o el sistema se reinicia, se pierde. Aquí se guarda una copia
// (con retardo, para no escribir en cada pulsación) y, al volver a abrir el archivo,
// se ofrece recuperarla.
//
// Varias ventanas comparten `localStorage`. Cada ventana firma sus copias con su
// identificador y solo borra las suyas; una copia cuya ventana sigue abierta es un
// borrador en curso, no uno que recuperar.

export const DRAFT_PREFIX = "markvi:draft:";

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StoredDraft {
  text: string;
  /** ETag del archivo en disco sobre el que se escribió; `null` si no se conocía. */
  base: string | null;
  /** Ventana que guardó la copia. */
  owner: string;
  /** Momento del último guardado (ms desde 1970). */
  at: number;
}

export function serializeDraft(draft: StoredDraft): string {
  return JSON.stringify({ v: VERSION, ...draft });
}

/** El contenido de `localStorage` puede estar corrupto o ser de otra versión. */
export function parseDraft(raw: string | null): StoredDraft | null {
  if (!raw) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const { v, text, base, owner, at } = value as Record<string, unknown>;
  if (v !== VERSION) return null;
  if (typeof text !== "string" || typeof owner !== "string") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (base !== null && typeof base !== "string") return null;
  return { text, base, owner, at };
}

export type Recovery =
  /** No hay nada que hacer con la copia. */
  | { kind: "none" }
  /** La copia ya no sirve (el disco tiene lo mismo): se borra. */
  | { kind: "discard" }
  /** Recuperar. `stale`: el archivo cambió en disco desde que se escribió la copia. */
  | { kind: "restore"; text: string; stale: boolean; at: number };

/**
 * Decide qué hacer con una copia al abrir un archivo con este contenido en disco.
 * `ownerAlive`: la ventana que la guardó sigue abierta, así que la copia es un
 * borrador en curso de esa ventana y no se toca.
 */
export function decideRecovery(
  draft: StoredDraft | null,
  disk: { text: string; etag?: string },
  ownerAlive: boolean,
): Recovery {
  if (!draft || ownerAlive) return { kind: "none" };
  if (draft.text === disk.text) return { kind: "discard" };
  const stale = draft.base === null || draft.base !== disk.etag;
  return { kind: "restore", text: draft.text, stale, at: draft.at };
}

// --- Ventanas abiertas (Web Locks) ----------------------------------------------

const WINDOW_LOCK = "markvi-window-";

export interface WindowLocks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

/** Mantiene un candado mientras la ventana esté abierta: así las demás saben que vive. */
export function holdWindowLock(id: string, locks: WindowLocks | null | undefined) {
  if (!locks) return;
  // La promesa nunca se resuelve: el navegador libera el candado al cerrar la página.
  locks.request(`${WINDOW_LOCK}${id}`, () => new Promise<void>(() => {})).catch(() => {});
}

/**
 * ¿Sigue abierta la ventana `id`? Sin Web Locks no se puede saber y se responde que
 * no: con una sola ventana abierta (lo habitual) es lo correcto.
 */
export async function isWindowAlive(id: string, locks: WindowLocks | null | undefined) {
  if (!locks) return false;
  try {
    const { held } = await locks.query();
    return held?.some((lock) => lock.name === `${WINDOW_LOCK}${id}`) ?? false;
  } catch {
    return false;
  }
}

// --- Almacén ----------------------------------------------------------------------

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export type DraftProblem = "too-large" | "quota";

export interface DraftStoreOptions {
  /** Identificador de esta ventana. */
  owner: string;
  /** Espera tras la última pulsación antes de escribir. */
  debounceMs?: number;
  /** Más largo que esto no se copia (el límite de `localStorage` es ~5 M de caracteres). */
  maxChars?: number;
  /** Las copias más antiguas se borran al arrancar. */
  ttlMs?: number;
  /** Una copia no se puede guardar: avisar al usuario de que no está protegido. */
  onProblem?: (problem: DraftProblem, path: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DraftStore {
  /** Pide guardar la copia de `path`; se escribe tras `debounceMs` sin nuevos cambios. */
  save(path: string, text: string, base: string | null): void;
  /** Escribe ya todo lo pendiente (al ocultar o cerrar la página). */
  flush(): void;
  /** Borra la copia si es de esta ventana. Las de otras ventanas no se tocan. */
  clear(path: string): void;
  /** Borra la copia de `path` sea de quien sea. */
  remove(path: string): void;
  load(path: string): StoredDraft | null;
  /** Borra copias caducadas o ilegibles. */
  sweep(): void;
}

export function createDraftStore(
  storage: DraftStorage | null,
  options: DraftStoreOptions,
): DraftStore {
  const {
    owner,
    debounceMs = 500,
    maxChars = 1_000_000,
    ttlMs = 30 * DAY_MS,
    onProblem,
    now = Date.now,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  const pending = new Map<string, { text: string; base: string | null }>();
  const timers = new Map<string, unknown>();
  /** Copias de esta ventana, escritas o pendientes. */
  const owned = new Set<string>();
  /** Última copia escrita, para no repetir escrituras idénticas. */
  const written = new Map<string, { text: string; base: string | null }>();
  const warned = new Set<string>();

  const keyOf = (path: string) => `${DRAFT_PREFIX}${path}`;

  const problem = (kind: DraftProblem, path: string) => {
    if (warned.has(path)) return;
    warned.add(path);
    onProblem?.(kind, path);
  };

  function write(path: string, entry: { text: string; base: string | null }) {
    if (!storage) return;
    const previous = written.get(path);
    if (previous && previous.text === entry.text && previous.base === entry.base) return;

    const value = serializeDraft({ ...entry, owner, at: now() });
    try {
      storage.setItem(keyOf(path), value);
    } catch {
      // Cuota llena: se liberan las copias caducadas y se reintenta una vez.
      sweep();
      try {
        storage.setItem(keyOf(path), value);
      } catch {
        problem("quota", path);
        return;
      }
    }
    written.set(path, entry);
    warned.delete(path);
  }

  function flushPath(path: string) {
    const handle = timers.get(path);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(path);

    const entry = pending.get(path);
    pending.delete(path);
    if (entry) write(path, entry);
  }

  function sweep() {
    if (!storage) return;
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
      const draft = parseDraft(storage.getItem(key));
      if (!draft || now() - draft.at > ttlMs) stale.push(key);
    }
    for (const key of stale) {
      try {
        storage.removeItem(key);
      } catch {
        // Sin almacenamiento utilizable no hay nada que limpiar.
      }
    }
  }

  function drop(path: string) {
    const handle = timers.get(path);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(path);
    pending.delete(path);
    owned.delete(path);
    written.delete(path);
    warned.delete(path);
    try {
      storage?.removeItem(keyOf(path));
    } catch {
      // Ya no se puede escribir: la copia caducará sola.
    }
  }

  return {
    save(path, text, base) {
      if (!storage) return;
      if (text.length > maxChars) {
        // Una copia vieja de este archivo sería engañosa: es de un texto anterior.
        if (owned.has(path)) drop(path);
        problem("too-large", path);
        return;
      }

      owned.add(path);
      const previous = pending.get(path) ?? written.get(path);
      if (previous && previous.text === text && previous.base === base) return;

      pending.set(path, { text, base });
      const handle = timers.get(path);
      if (handle !== undefined) clearTimer(handle);
      timers.set(
        path,
        setTimer(() => flushPath(path), debounceMs),
      );
    },

    flush() {
      for (const path of [...pending.keys()]) flushPath(path);
    },

    clear(path) {
      if (owned.has(path)) drop(path);
    },

    remove: drop,

    load(path) {
      if (!storage) return null;
      try {
        return parseDraft(storage.getItem(keyOf(path)));
      } catch {
        return null;
      }
    },

    sweep,
  };
}
