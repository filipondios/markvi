import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWatcher, type DiskEvent, type FileWatcher } from "./watch.ts";

let base: string;
let root: string;
let watcher: FileWatcher;
let events: DiskEvent[];

const waitFor = async (check: () => boolean, timeout = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("tiempo de espera agotado");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-watch-")));
  root = join(base, "root");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "existente.md"), "inicial");
  watcher = createFileWatcher(root);
  events = [];
  watcher.subscribe((event) => events.push(event));
});

afterAll(async () => {
  watcher.close();
  await rm(base, { recursive: true, force: true });
});

test("avisa cuando se crea o modifica un Markdown", async () => {
  events = [];
  await writeFile(join(root, "nuevo.md"), "# hola\n");
  await waitFor(() => events.some((event) => event.path === "nuevo.md"));
  const event = events.find((item) => item.path === "nuevo.md")!;
  expect(event.type).toBe("change");
});

test("avisa cuando se borra un Markdown", async () => {
  events = [];
  await rm(join(root, "existente.md"));
  await waitFor(() => events.some((event) => event.path === "existente.md"));
  const event = events.find((item) => item.path === "existente.md")!;
  expect(event.type).toBe("delete");
});

test("ignora archivos que no son Markdown", async () => {
  events = [];
  await writeFile(join(root, "nota.txt"), "texto");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(events.some((event) => event.path === "nota.txt")).toBe(false);
});

test("deja de avisar al cerrar", async () => {
  const local = createFileWatcher(root);
  const received: DiskEvent[] = [];
  local.subscribe((event) => received.push(event));
  local.close();

  await writeFile(join(root, "cerrado.md"), "# ya no\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(received).toEqual([]);
});

const has = (type: DiskEvent["type"], path: string) =>
  events.some((event) => event.type === type && event.path === path);

test("renombrar una carpeta avisa del borrado de las rutas antiguas y de las nuevas", async () => {
  await mkdir(join(root, "carpeta", "sub"), { recursive: true });
  await writeFile(join(root, "carpeta", "uno.md"), "# uno\n");
  await writeFile(join(root, "carpeta", "sub", "dos.md"), "# dos\n");
  await waitFor(() => has("change", "carpeta/sub/dos.md") && has("change", "carpeta/uno.md"));

  events = [];
  await rename(join(root, "carpeta"), join(root, "renombrada"));

  await waitFor(
    () =>
      has("delete", "carpeta/uno.md") &&
      has("delete", "carpeta/sub/dos.md") &&
      has("change", "renombrada/uno.md") &&
      has("change", "renombrada/sub/dos.md"),
  );
});

test("mover una carpeta fuera del raíz avisa del borrado de sus archivos", async () => {
  events = [];
  await rename(join(root, "renombrada"), join(base, "fuera"));

  await waitFor(() => has("delete", "renombrada/uno.md") && has("delete", "renombrada/sub/dos.md"));
  expect(has("change", "renombrada/uno.md")).toBe(false);
});

test("mover una carpeta al raíz avisa de sus archivos aunque el sistema no los nombre", async () => {
  events = [];
  await rename(join(base, "fuera"), join(root, "devuelta"));

  await waitFor(() => has("change", "devuelta/uno.md") && has("change", "devuelta/sub/dos.md"));
});

test("borrar una carpeta con Markdown avisa de cada archivo", async () => {
  events = [];
  await rm(join(root, "devuelta"), { recursive: true });

  await waitFor(() => has("delete", "devuelta/uno.md") && has("delete", "devuelta/sub/dos.md"));
});

test("conoce los archivos que ya existían al arrancar", async () => {
  const preRoot = join(base, "previo");
  await mkdir(join(preRoot, "dir"), { recursive: true });
  await writeFile(join(preRoot, "dir", "antiguo.md"), "# antiguo\n");

  const local = createFileWatcher(preRoot);
  const received: DiskEvent[] = [];
  local.subscribe((event) => received.push(event));
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rename(join(preRoot, "dir"), join(base, "previo-fuera"));
    await waitFor(() =>
      received.some((event) => event.type === "delete" && event.path === "dir/antiguo.md"),
    );
  } finally {
    local.close();
  }
});

test("las carpetas sin Markdown y los archivos sueltos no generan avisos", async () => {
  events = [];
  await mkdir(join(root, "solo-imagenes"));
  await writeFile(join(root, "solo-imagenes", "foto.png"), "x");
  await rename(join(root, "solo-imagenes"), join(base, "solo-imagenes-fuera"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(events).toEqual([]);
});
