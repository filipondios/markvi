import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNew } from "./files.ts";

let base: string;
let root: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-new-")));
  root = join(base, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(root, ".git"));
  await mkdir(join(base, "fuera"));
  await writeFile(join(root, "existe.md"), "x");
  await symlink(join(base, "fuera"), join(root, "enlace-fuera"));
  await symlink(join(root, "sub"), join(root, "enlace-dentro"));
  await symlink(join(base, "no-existe.md"), join(root, "roto.md"));
});

afterAll(() => rm(base, { recursive: true, force: true }));

const status = (path: string | null) =>
  resolveNew(root, path).then(
    () => 200,
    (error) => error.status,
  );

test("acepta un archivo nuevo en el raíz, en una carpeta existente y en una nueva", async () => {
  expect(await resolveNew(root, "nuevo.md")).toBe(join(root, "nuevo.md"));
  expect(await resolveNew(root, "sub/nuevo.md")).toBe(join(root, "sub", "nuevo.md"));
  expect(await resolveNew(root, "a/b/c/nuevo.md")).toBe(join(root, "a", "b", "c", "nuevo.md"));
});

test("rechaza lo que ya existe, incluido un symlink roto", async () => {
  expect(await status("existe.md")).toBe(409);
  expect(await status("sub")).toBe(409);
  expect(await status("roto.md")).toBe(409);
});

test("rechaza rutas inválidas o fuera del raíz", async () => {
  expect(await status(null)).toBe(400);
  expect(await status("")).toBe(400);
  expect(await status("a\0b.md")).toBe(400);
  expect(await status("../fuera.md")).toBe(403);
  expect(await status("sub/../../fuera.md")).toBe(403);
  expect(await status(join(base, "abs.md"))).toBe(403);
});

test("rechaza carpetas y archivos ocultos", async () => {
  expect(await status(".oculto.md")).toBe(400);
  expect(await status(".git/x.md")).toBe(400);
  expect(await status("sub/.cache/x.md")).toBe(400);
  expect(await status("node_modules/x.md")).toBe(400);
});

test("un enlace simbólico no puede sacar el archivo del raíz", async () => {
  expect(await status("enlace-fuera/x.md")).toBe(403);
  expect(await status("enlace-fuera/nueva/x.md")).toBe(403);
  // Un enlace que apunta dentro del raíz sí es válido.
  expect(await status("enlace-dentro/x.md")).toBe(200);
});
