import { expect, test } from "bun:test";
import { isCaseSensitive } from "./shared/case.ts";
import { matchOffsets } from "./search.ts";

test("encuentra todas las coincidencias sin solaparse", () => {
  expect(matchOffsets("hola hola hola", "hola", false)).toEqual([
    { start: 0, end: 4 },
    { start: 5, end: 9 },
    { start: 10, end: 14 },
  ]);
  expect(matchOffsets("aaaa", "aa", false)).toEqual([
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  expect(matchOffsets("abc", "", false)).toEqual([]);
  expect(matchOffsets("abc", "z", false)).toEqual([]);
});

test("smart case: distingue mayúsculas solo si la consulta las lleva", () => {
  expect(isCaseSensitive("hola")).toBe(false);
  expect(isCaseSensitive("Hola")).toBe(true);
  expect(isCaseSensitive("Ñ")).toBe(true);
  // Cualquier mayúscula Unicode activa el modo sensible, no solo las españolas:
  // el documento, el finder y la búsqueda del servidor comparten esta regla.
  for (const upper of ["Ö", "Ä", "Ż", "Ω", "É"]) {
    expect(isCaseSensitive(upper)).toBe(true);
  }

  expect(matchOffsets("Hola hola", "hola", false)).toHaveLength(2);
  expect(matchOffsets("Hola hola", "Hola", true)).toEqual([{ start: 0, end: 4 }]);
});
