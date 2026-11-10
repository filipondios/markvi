import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
