import { expect, test } from "bun:test";
import {
  FILES_URL,
  VIEW_PREFIX,
  fileUrl,
  isMarkdownPath,
  isSafePath,
  normalizeNewPath,
  normalizePath,
  viewUrl,
} from "./paths.ts";

test("normalizePath unifica separadores y quita prefijos", () => {
  expect(normalizePath("a\\b.md")).toBe("a/b.md");
  expect(normalizePath("./a.md")).toBe("a.md");
  expect(normalizePath("//a.md")).toBe("a.md");
});

test("isMarkdownPath e isSafePath son la única regla de extensión y seguridad", () => {
  expect(isMarkdownPath("A.MD")).toBe(true);
  expect(isMarkdownPath("a.txt")).toBe(false);
  expect(isSafePath("a/b.md")).toBe(true);
  expect(isSafePath("../secreto.md")).toBe(false);
  expect(isSafePath(".oculto.md")).toBe(false);
  expect(isSafePath("a\\b.md")).toBe(false);
  expect(isSafePath("a//b.md")).toBe(false);
});

test("normalizeNewPath aplica .md y valida con la misma regla", () => {
  expect(normalizeNewPath("notas/idea")).toBe("notas/idea.md");
  expect(normalizeNewPath("./idea.md")).toBe("idea.md");
  expect(normalizeNewPath("../idea")).toBeNull();
  expect(normalizeNewPath("idea.txt")).toBe("idea.txt.md");
});

test("las URLs de vista y archivo salen de las mismas constantes", () => {
  expect(VIEW_PREFIX).toBe("/view/");
  expect(viewUrl("a b/c.md")).toBe("/view/a%20b/c.md");
  expect(fileUrl("a b/c.md")).toBe(`${FILES_URL}?path=a%20b%2Fc.md`);
});
