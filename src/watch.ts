import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { isIgnored, isMarkdown, listMarkdown } from "./files.ts";

export type DiskEventType = "change" | "delete";

export interface DiskEvent {
  type: DiskEventType;
  path: string;
}

export type DiskListener = (event: DiskEvent) => void;

export interface FileWatcher {
  subscribe(listener: DiskListener): () => void;
  close(): void;
}

// Los editores y algunos sistemas de archivos emiten varios eventos por una
// sola escritura (`rename` + `change`); se agrupan por ruta antes de avisar.
const DEBOUNCE_MS = 80;

export function createFileWatcher(root: string): FileWatcher {
  const listeners = new Set<DiskListener>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: FSWatcher | undefined;
  let closed = false;

  // Markdown que existen según lo último que se vio. `fs.watch` solo avisa de la
  // carpeta, no de los archivos que contiene, cuando se renombra (avisa de la ruta
  // nueva, no de la antigua) o se mueve fuera del raíz (no avisa de ninguno). Con
  // este conjunto se averigua qué archivos desaparecieron o aparecieron.
  const known = new Set<string>();
  const ready = listMarkdown(root).then(
    (files) => {
      for (const file of files) known.add(file);
    },
    () => {
      // Sin la lista inicial solo se pierde la detección por carpetas.
    },
  );

  const emit = (event: DiskEvent) => {
    if (closed) return;
    if (event.type === "change") known.add(event.path);
    else known.delete(event.path);

    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Un cliente roto no debe impedir avisar al resto.
      }
    }
  };

  // Una sola pasada a la vez; si llegan más eventos mientras corre, se repite al acabar.
  let reconciling = false;
  let again = false;

  async function reconcile() {
    if (reconciling) {
      again = true;
      return;
    }
    reconciling = true;
    try {
      do {
        again = false;
        await ready;
        const current = new Set(await listMarkdown(root));
        for (const path of [...known]) {
          if (!current.has(path)) emit({ type: "delete", path });
        }
        for (const path of current) {
          if (!known.has(path)) emit({ type: "change", path });
        }
      } while (again && !closed);
    } catch {
      // Si la carpeta no se puede leer, se mantiene lo que había.
    } finally {
      reconciling = false;
    }
  }

  const hasKnownUnder = (directory: string) => {
    const prefix = `${directory}/`;
    for (const path of known) if (path.startsWith(prefix)) return true;
    return false;
  };

  const later = (key: string, task: () => Promise<void>) => {
    const previous = timers.get(key);
    if (previous) clearTimeout(previous);

    timers.set(
      key,
      setTimeout(async () => {
        timers.delete(key);
        if (closed) return;
        await task();
      }, DEBOUNCE_MS),
    );
  };

  const scheduleFile = (path: string) => {
    later(path, async () => {
      const info = await stat(join(root, path)).catch(() => null);
      // Una carpeta con nombre `*.md` no es un archivo: se trata como carpeta.
      if (info?.isDirectory()) return reconcile();
      emit({ type: info?.isFile() ? "change" : "delete", path });
    });
  };

  // Ruta que no es Markdown: puede ser una carpeta que se creó, borró, renombró o
  // movió. Sus archivos no avisan por separado, así que se reconcilia con el disco.
  // Los archivos sueltos de otro tipo (imágenes, `.txt`) no cuestan nada: se descartan.
  const scheduleDirectory = (path: string) => {
    // El prefijo NUL no puede aparecer en un nombre de archivo: no choca con `scheduleFile`.
    later(`\0${path}`, async () => {
      await ready;
      const info = await stat(join(root, path)).catch(() => null);
      if (info?.isFile()) return;
      // Ya no existe: solo importa si era una carpeta con Markdown dentro.
      if (!info && !hasKnownUnder(path)) return;
      await reconcile();
    });
  };

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const path = filename.toString().split(sep).join("/");
      // La API nunca sirve estas rutas (.git, node_modules, ocultos): no hay que
      // hacer stat ni avisar a los clientes por cada README de una dependencia.
      if (path.split("/").some(isIgnored)) return;

      if (isMarkdown(path)) scheduleFile(path);
      else scheduleDirectory(path);
    });
    watcher.on("error", (error) => console.error("File watcher:", error));
  } catch (error) {
    console.error("Could not watch the directory:", error);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      listeners.clear();
      watcher?.close();
      watcher = undefined;
    },
  };
}
