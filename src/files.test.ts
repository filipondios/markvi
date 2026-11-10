import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMarkdown, resolveFile } from "./files.ts";

let base: string;
let root: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-")));
  root = join(base, "root");
  for (const dir of ["sub", ".oculta", "node_modules/pkg", ".git"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  for (const file of ["b.md", "a.MD", "c.txt", "sub/d.md", ".oculta/e.md", "node_modules/pkg/f.md", ".g.md"]) {
    await writeFile(join(root, file), file);
  }
  await writeFile(join(base, "secreto.md"), "secreto");
  await symlink(join(base, "secreto.md"), join(root, "enlace.md"));
});

afterAll(() => rm(base, { recursive: true, force: true }));

const status = (path: string | null) =>
  resolveFile(root, path).then(
    () => 200,
    (error) => error.status,
  );

test("lista solo .md visibles, archivos antes que carpetas", async () => {
  expect(await listMarkdown(root)).toEqual(["a.MD", "b.md", "sub/d.md"]);
});

test("resuelve archivos dentro del raíz", async () => {
  expect(await resolveFile(root, "sub/d.md")).toBe(join(root, "sub/d.md"));
  expect(await resolveFile(root, "sub/../c.txt")).toBe(join(root, "c.txt"));
});

test("rechaza rutas fuera del raíz", async () => {
  expect(await status("../secreto.md")).toBe(403);
  expect(await status("sub/../../secreto.md")).toBe(403);
  expect(await status(join(base, "secreto.md"))).toBe(403);
  expect(await status("enlace.md")).toBe(403);
  expect(await status(".")).toBe(403);
});

test("rechaza rutas ocultas, inexistentes o inválidas", async () => {
  expect(await status(".oculta/e.md")).toBe(404);
  expect(await status("node_modules/pkg/f.md")).toBe(404);
  expect(await status(".g.md")).toBe(404);
  expect(await status("nada.md")).toBe(404);
  expect(await status("sub")).toBe(404);
  expect(await status(null)).toBe(400);
  expect(await status("a\0.md")).toBe(400);
});
