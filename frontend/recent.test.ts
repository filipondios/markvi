import { expect, test } from "bun:test";
import {
  alternatePath,
  MAX_RECENT,
  parseRecent,
  recentChoices,
  recordVisit,
  removeRecent,
  renameRecent,
  serializeRecent,
} from "./recent.ts";

test("recordVisit mueve al principio y no duplica", () => {
  expect(recordVisit([], "a.md")).toEqual(["a.md"]);
  expect(recordVisit(["a.md", "b.md", "c.md"], "c.md")).toEqual(["c.md", "a.md", "b.md"]);
  expect(recordVisit(["a.md", "b.md"], "a.md")).toEqual(["a.md", "b.md"]);
});

test("recordVisit recorta a `max`", () => {
  const list = Array.from({ length: MAX_RECENT }, (_, index) => `f${index}.md`);
  const next = recordVisit(list, "nuevo.md");
  expect(next).toHaveLength(MAX_RECENT);
  expect(next[0]).toBe("nuevo.md");
  expect(next).not.toContain(`f${MAX_RECENT - 1}.md`);
  expect(recordVisit(["a.md", "b.md", "c.md"], "d.md", 2)).toEqual(["d.md", "a.md"]);
});

test("alternatePath es el más reciente distinto del actual", () => {
  expect(alternatePath(["a.md", "b.md", "c.md"], "a.md")).toBe("b.md");
  expect(alternatePath(["a.md", "b.md"], "b.md")).toBe("a.md");
  expect(alternatePath(["a.md"], "a.md")).toBeUndefined();
  expect(alternatePath([], "a.md")).toBeUndefined();
  expect(alternatePath(["a.md", "b.md"])).toBe("a.md");
});

test("alternar entre dos archivos mantiene el par", () => {
  let list = recordVisit(recordVisit([], "a.md"), "b.md");
  expect(alternatePath(list, "b.md")).toBe("a.md");
  list = recordVisit(list, "a.md");
  expect(alternatePath(list, "a.md")).toBe("b.md");
});

test("renameRecent conserva el orden y evita duplicados", () => {
  expect(renameRecent(["a.md", "b.md", "c.md"], "b.md", "z.md")).toEqual(["a.md", "z.md", "c.md"]);
  expect(renameRecent(["a.md", "b.md", "c.md"], "c.md", "a.md")).toEqual(["a.md", "b.md"]);
  expect(renameRecent(["a.md"], "x.md", "y.md")).toEqual(["a.md"]);
});

test("removeRecent quita una ruta", () => {
  expect(removeRecent(["a.md", "b.md"], "a.md")).toEqual(["b.md"]);
  expect(removeRecent(["a.md"], "x.md")).toEqual(["a.md"]);
});

test("recentChoices filtra los inexistentes y el archivo actual", () => {
  expect(recentChoices(["a.md", "b.md", "c.md", "d.md"], ["a.md", "c.md", "d.md"], "a.md")).toEqual([
    "c.md",
    "d.md",
  ]);
  expect(recentChoices(["a.md"], [], undefined)).toEqual([]);
});

test("parseRecent valida el contenido guardado", () => {
  expect(parseRecent(null)).toEqual([]);
  expect(parseRecent("no es json")).toEqual([]);
  expect(parseRecent('{"a":1}')).toEqual([]);
  expect(
    parseRecent(JSON.stringify(["a.md", 3, "../x.md", ".oculto.md", "/abs.md", "a.md", "sub/b.md", "c.txt"])),
  ).toEqual(["a.md", "sub/b.md"]);
});

test("serializeRecent y parseRecent son inversos", () => {
  const list = ["sub/a.md", "b.md"];
  expect(parseRecent(serializeRecent(list))).toEqual(list);
});
