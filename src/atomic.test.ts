import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileExclusive, withFileLock, writeFileAtomic } from "./atomic.ts";

let dir: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "markvi-atomic-")));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Nombres de la carpeta, ocultos incluidos: no debe quedar ningún temporal. */
const names = async (path = dir) => (await readdir(path)).sort();
const leftovers = async (path = dir) => (await names(path)).filter((name) => name.endsWith(".tmp"));

test("writeFileAtomic crea el archivo y sustituye el contenido sin dejar temporales", async () => {
  const file = join(dir, "a.md");
  await writeFileAtomic(file, "uno\n");
  expect(await readFile(file, "utf8")).toBe("uno\n");

  await writeFileAtomic(file, "dos\ncon ñ y 😀\n");
  expect(await readFile(file, "utf8")).toBe("dos\ncon ñ y 😀\n");
  expect(await leftovers()).toEqual([]);
});

test("writeFileAtomic conserva los permisos del archivo existente", async () => {
  if (process.platform === "win32") return;
  for (const mode of [0o600, 0o640, 0o664, 0o755]) {
    const file = join(dir, `modo-${mode.toString(8)}.md`);
    await writeFile(file, "x");
    await chmod(file, mode);
    await writeFileAtomic(file, "nuevo");
    expect((await stat(file)).mode & 0o7777).toBe(mode);
  }
});

test("si falla, el archivo original queda intacto y no queda el temporal", async () => {
  // Un directorio con nombre de archivo: el rename del temporal encima falla.
  const blocker = join(dir, "es-carpeta.md");
  await mkdir(blocker);
  await writeFile(join(blocker, "dentro.md"), "no tocar");

  await expect(writeFileAtomic(blocker, "x")).rejects.toThrow();
  expect((await stat(blocker)).isDirectory()).toBe(true);
  expect(await readFile(join(blocker, "dentro.md"), "utf8")).toBe("no tocar");
  expect(await leftovers()).toEqual([]);

  // Carpeta inexistente: tampoco deja nada.
  await expect(writeFileAtomic(join(dir, "no-existe", "x.md"), "x")).rejects.toThrow();
});

test("los temporales son ocultos: el listado y el watcher nunca los ven", async () => {
  const seen: string[] = [];
  const file = join(dir, "oculto.md");
  const writing = writeFileAtomic(file, "x".repeat(1_000_000));
  // Mientras se escribe, cualquier temporal visible empezaría por `.`.
  for (let i = 0; i < 20; i++) {
    seen.push(...(await names()).filter((name) => name.endsWith(".tmp")));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await writing;
  expect(seen.every((name) => name.startsWith("."))).toBe(true);
});

test("una lectura nunca ve el archivo vacío o a medias mientras se reescribe", async () => {
  const file = join(dir, "grande.md");
  const old = "A".repeat(4_000_000);
  const next = "B".repeat(4_000_000);
  await writeFile(file, old);

  let stop = false;
  let reads = 0;
  let broken = 0;
  const reader = (async () => {
    while (!stop) {
      const text = await readFile(file, "utf8");
      reads++;
      if (text !== old && text !== next) broken++;
    }
  })();

  for (let i = 0; i < 15; i++) await writeFileAtomic(file, i % 2 ? old : next);
  stop = true;
  await reader;

  expect(reads).toBeGreaterThan(0);
  expect(broken).toBe(0);
});

test("createFileExclusive crea con el contenido completo y nunca sobrescribe", async () => {
  const file = join(dir, "nuevo.md");
  await createFileExclusive(file, "# hola\n");
  expect(await readFile(file, "utf8")).toBe("# hola\n");

  await expect(createFileExclusive(file, "otro")).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(file, "utf8")).toBe("# hola\n");
  expect(await leftovers()).toEqual([]);
});

test("con varios creadores a la vez gana uno solo y su contenido queda entero", async () => {
  const file = join(dir, "carrera.md");
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => createFileExclusive(file, `escritor ${i}\n`.repeat(5000))),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const winner = results.findIndex((result) => result.status === "fulfilled");
  expect(await readFile(file, "utf8")).toBe(`escritor ${winner}\n`.repeat(5000));
  expect(await leftovers()).toEqual([]);
});

test("withFileLock ejecuta en orden las tareas de la misma clave", async () => {
  const order: string[] = [];
  const task = (name: string, ms: number) => () =>
    new Promise<string>((resolve) => {
      order.push(`inicio ${name}`);
      setTimeout(() => {
        order.push(`fin ${name}`);
        resolve(name);
      }, ms);
    });

  const results = await Promise.all([
    withFileLock("k", task("a", 30)),
    withFileLock("k", task("b", 5)),
    withFileLock("k", task("c", 1)),
  ]);
  expect(results).toEqual(["a", "b", "c"]);
  expect(order).toEqual(["inicio a", "fin a", "inicio b", "fin b", "inicio c", "fin c"]);
});

test("withFileLock no bloquea otras claves ni se atasca tras un error", async () => {
  const order: string[] = [];
  const slow = withFileLock("x", async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push("x");
  });
  const other = withFileLock("y", async () => {
    order.push("y");
  });
  await other;
  expect(order).toEqual(["y"]);
  await slow;

  const failing = withFileLock("z", async () => {
    throw new Error("falla");
  });
  const after = withFileLock("z", async () => "sigue");
  await expect(failing).rejects.toThrow("falla");
  expect(await after).toBe("sigue");
});

test("escrituras concurrentes bajo el candado dejan siempre un contenido íntegro", async () => {
  const file = join(dir, "concurrente.md");
  await writeFile(file, "inicio");
  const bodies = Array.from({ length: 30 }, (_, i) => `versión ${i}\n`.repeat(2000));
  await Promise.all(bodies.map((body) => withFileLock(file, () => writeFileAtomic(file, body))));
  expect(await readFile(file, "utf8")).toBe(bodies[29]!);
  expect(await leftovers()).toEqual([]);
});
