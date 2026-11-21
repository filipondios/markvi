import { expect, test } from "bun:test";
import {
  DRAFT_PREFIX,
  createDraftStore,
  decideRecovery,
  holdWindowLock,
  isWindowAlive,
  parseDraft,
  serializeDraft,
  type DraftProblem,
  type DraftStorage,
  type StoredDraft,
  type WindowLocks,
} from "./drafts.ts";

class FakeStorage implements DraftStorage {
  data = new Map<string, string>();
  writes = 0;
  failWrites = 0;
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("QuotaExceededError");
    }
    this.writes++;
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

/** Reloj y temporizadores manuales. */
function clock() {
  let time = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => time,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, run });
      return id;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    advance(ms: number) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    pending: () => timers.size,
  };
}

function setup(owner = "w1", extra: { maxChars?: number; ttlMs?: number } = {}) {
  const storage = new FakeStorage();
  const time = clock();
  const problems: [DraftProblem, string][] = [];
  const store = createDraftStore(storage, {
    owner,
    debounceMs: 500,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onProblem: (problem, path) => problems.push([problem, path]),
    ...extra,
  });
  return { storage, time, store, problems };
}

const key = (path: string) => `${DRAFT_PREFIX}${path}`;
const draft = (over: Partial<StoredDraft> = {}): StoredDraft => ({
  text: "texto",
  base: '"abc"',
  owner: "w1",
  at: 1,
  ...over,
});

// --- Serialización -------------------------------------------------------------------

test("serializeDraft y parseDraft son inversos", () => {
  const original = draft({ text: "línea 1\nñ 😀\n", base: null });
  expect(parseDraft(serializeDraft(original))).toEqual(original);
});

test("parseDraft descarta contenido corrupto, de otra versión o con tipos incorrectos", () => {
  expect(parseDraft(null)).toBeNull();
  expect(parseDraft("")).toBeNull();
  expect(parseDraft("no es json")).toBeNull();
  expect(parseDraft("null")).toBeNull();
  expect(parseDraft("[1,2]")).toBeNull();
  const ok = JSON.parse(serializeDraft(draft()));
  expect(parseDraft(JSON.stringify({ ...ok, v: 2 }))).toBeNull();
  expect(parseDraft(JSON.stringify({ ...ok, text: 5 }))).toBeNull();
  expect(parseDraft(JSON.stringify({ ...ok, owner: undefined }))).toBeNull();
  expect(parseDraft(JSON.stringify({ ...ok, at: "ayer" }))).toBeNull();
  expect(parseDraft(JSON.stringify({ ...ok, base: 3 }))).toBeNull();
});

// --- Decisión ------------------------------------------------------------------------

test("decideRecovery: sin copia o con la ventana dueña abierta no hace nada", () => {
  expect(decideRecovery(null, { text: "x" }, false)).toEqual({ kind: "none" });
  expect(decideRecovery(draft(), { text: "otro", etag: '"abc"' }, true)).toEqual({ kind: "none" });
});

test("decideRecovery: si el disco ya tiene el mismo texto la copia se descarta", () => {
  expect(decideRecovery(draft({ text: "igual" }), { text: "igual", etag: '"zzz"' }, false)).toEqual({
    kind: "discard",
  });
});

test("decideRecovery: con el disco sin cambios se recupera sin conflicto", () => {
  expect(
    decideRecovery(draft({ text: "mío", base: '"abc"', at: 42 }), { text: "disco", etag: '"abc"' }, false),
  ).toEqual({ kind: "restore", text: "mío", stale: false, at: 42 });
});

test("decideRecovery: si el disco cambió, o no se sabía la base, se recupera como conflicto", () => {
  const changed = decideRecovery(draft({ base: '"abc"' }), { text: "otro", etag: '"nuevo"' }, false);
  expect(changed).toMatchObject({ kind: "restore", stale: true });
  const unknown = decideRecovery(draft({ base: null }), { text: "otro", etag: '"nuevo"' }, false);
  expect(unknown).toMatchObject({ kind: "restore", stale: true });
  const noEtag = decideRecovery(draft({ base: '"abc"' }), { text: "otro" }, false);
  expect(noEtag).toMatchObject({ kind: "restore", stale: true });
});

// --- Almacén -------------------------------------------------------------------------

test("save espera a que pasen los milisegundos sin cambios y escribe solo la última versión", () => {
  const { storage, time, store } = setup();
  store.save("a.md", "uno", '"e1"');
  time.advance(300);
  store.save("a.md", "uno dos", '"e1"');
  time.advance(300);
  store.save("a.md", "uno dos tres", '"e1"');
  expect(storage.writes).toBe(0);

  time.advance(500);
  expect(storage.writes).toBe(1);
  expect(store.load("a.md")).toMatchObject({ text: "uno dos tres", base: '"e1"', owner: "w1" });
});

test("flush escribe ya lo pendiente y no repite escrituras idénticas", () => {
  const { storage, time, store } = setup();
  store.save("a.md", "x", null);
  store.save("b.md", "y", null);
  store.flush();
  expect(storage.writes).toBe(2);
  expect(time.pending()).toBe(0);

  store.save("a.md", "x", null);
  store.flush();
  time.advance(1000);
  expect(storage.writes).toBe(2);
});

test("clear borra la copia propia y cancela lo pendiente", () => {
  const { storage, time, store } = setup();
  store.save("a.md", "x", null);
  store.clear("a.md");
  time.advance(1000);
  expect(storage.data.size).toBe(0);
  expect(storage.writes).toBe(0);

  store.save("b.md", "y", null);
  store.flush();
  expect(storage.data.has(key("b.md"))).toBe(true);
  store.clear("b.md");
  expect(storage.data.has(key("b.md"))).toBe(false);
});

test("clear no toca las copias de otra ventana; remove sí", () => {
  const { storage, store } = setup("w1");
  storage.data.set(key("ajena.md"), serializeDraft(draft({ owner: "w2", text: "de otra ventana" })));

  store.clear("ajena.md");
  expect(storage.data.has(key("ajena.md"))).toBe(true);

  store.remove("ajena.md");
  expect(storage.data.has(key("ajena.md"))).toBe(false);
});

test("una ventana que recupera una copia ajena pasa a ser su dueña", () => {
  const { storage, store } = setup("w2");
  storage.data.set(key("a.md"), serializeDraft(draft({ owner: "w1", text: "antiguo" })));

  store.save("a.md", "antiguo + cambios", '"abc"');
  store.flush();
  expect(store.load("a.md")).toMatchObject({ owner: "w2", text: "antiguo + cambios" });

  store.clear("a.md");
  expect(storage.data.has(key("a.md"))).toBe(false);
});

test("load ignora copias ilegibles", () => {
  const { storage, store } = setup();
  storage.data.set(key("rota.md"), "{no json");
  expect(store.load("rota.md")).toBeNull();
  expect(store.load("no-existe.md")).toBeNull();
});

test("sweep borra las caducadas y las ilegibles y respeta el resto", () => {
  const { storage, time, store } = setup("w1", { ttlMs: 10_000 });
  const t = time.now();
  storage.data.set(key("vieja.md"), serializeDraft(draft({ at: t - 20_000 })));
  storage.data.set(key("reciente.md"), serializeDraft(draft({ at: t - 1_000 })));
  storage.data.set(key("rota.md"), "basura");
  storage.data.set("markvi:tabs", '{"tabs":[]}');
  storage.data.set("otra-app:draft:x", "no mío");

  store.sweep();
  expect([...storage.data.keys()].sort()).toEqual(
    [key("reciente.md"), "markvi:tabs", "otra-app:draft:x"].sort(),
  );
});

test("un texto demasiado grande no se copia, avisa una sola vez y retira la copia anterior", () => {
  const { storage, time, store, problems } = setup("w1", { maxChars: 10 });
  store.save("a.md", "corto", null);
  store.flush();
  expect(storage.data.has(key("a.md"))).toBe(true);

  store.save("a.md", "x".repeat(50), null);
  store.save("a.md", "x".repeat(60), null);
  time.advance(1000);
  expect(storage.data.has(key("a.md"))).toBe(false);
  expect(problems).toEqual([["too-large", "a.md"]]);
});

test("si la cuota está llena libera copias caducadas y reintenta; si sigue fallando avisa", () => {
  const { storage, time, store, problems } = setup("w1", { ttlMs: 10_000 });
  storage.data.set(key("vieja.md"), serializeDraft(draft({ at: time.now() - 20_000 })));

  storage.failWrites = 1; // falla la primera escritura, el reintento funciona
  store.save("a.md", "x", null);
  store.flush();
  expect(storage.data.has(key("a.md"))).toBe(true);
  expect(storage.data.has(key("vieja.md"))).toBe(false);
  expect(problems).toEqual([]);

  storage.failWrites = 2; // falla también el reintento
  store.save("b.md", "y", null);
  expect(() => store.flush()).not.toThrow();
  expect(storage.data.has(key("b.md"))).toBe(false);
  expect(problems).toEqual([["quota", "b.md"]]);
});

test("sin almacenamiento todo son operaciones vacías", () => {
  const store = createDraftStore(null, { owner: "w1" });
  store.save("a.md", "x", null);
  store.flush();
  store.clear("a.md");
  store.remove("a.md");
  store.sweep();
  expect(store.load("a.md")).toBeNull();
});

// --- Ventanas abiertas -----------------------------------------------------------------

function fakeLocks(held: string[] = []) {
  const requested: string[] = [];
  const locks: WindowLocks = {
    request(name) {
      requested.push(name);
      held.push(name);
      return new Promise(() => {});
    },
    async query() {
      return { held: held.map((name) => ({ name })) };
    },
  };
  return { locks, requested, held };
}

test("holdWindowLock toma un candado con el identificador de la ventana", async () => {
  const { locks, requested } = fakeLocks();
  holdWindowLock("abc", locks);
  expect(requested).toEqual(["markvi-window-abc"]);
  expect(await isWindowAlive("abc", locks)).toBe(true);
  expect(await isWindowAlive("otra", locks)).toBe(false);
});

test("isWindowAlive responde que no si no hay Web Locks o falla", async () => {
  expect(await isWindowAlive("x", null)).toBe(false);
  expect(await isWindowAlive("x", undefined)).toBe(false);
  const broken: WindowLocks = {
    request: () => new Promise(() => {}),
    query: () => Promise.reject(new Error("SecurityError")),
  };
  expect(await isWindowAlive("x", broken)).toBe(false);
  expect(() => holdWindowLock("x", null)).not.toThrow();
});
