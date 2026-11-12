import { expect, test } from "bun:test";
import { normalizeNewPath } from "./newfile.ts";

test("añade la extensión .md y recorta espacios y ./", () => {
  expect(normalizeNewPath("idea")).toBe("idea.md");
  expect(normalizeNewPath("  idea  ")).toBe("idea.md");
  expect(normalizeNewPath("./notas/idea")).toBe("notas/idea.md");
  expect(normalizeNewPath("IDEA.MD")).toBe("IDEA.MD");
  expect(normalizeNewPath("mi nota")).toBe("mi nota.md");
});

test("colapsa barras repetidas", () => {
  expect(normalizeNewPath("a//b///c")).toBe("a/b/c.md");
});

test("rechaza rutas vacías, ocultas, absolutas o que escapan del raíz", () => {
  expect(normalizeNewPath("")).toBeNull();
  expect(normalizeNewPath("   ")).toBeNull();
  expect(normalizeNewPath(".oculto")).toBeNull();
  expect(normalizeNewPath("a/.oculto/b")).toBeNull();
  expect(normalizeNewPath("../fuera")).toBeNull();
  expect(normalizeNewPath("a/../b")).toBeNull();
  expect(normalizeNewPath("/etc/passwd")).toBeNull();
  expect(normalizeNewPath("a\\b")).toBeNull();
  expect(normalizeNewPath("carpeta/")).toBeNull();
});

test("rechaza caracteres de control", () => {
  expect(normalizeNewPath("a\u0000b")).toBeNull();
  expect(normalizeNewPath("a\nb")).toBeNull();
});
