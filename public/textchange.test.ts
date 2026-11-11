import { describe, expect, test } from "bun:test";
import { minimalTextChange } from "./textchange.ts";

const apply = (source: string, change: ReturnType<typeof minimalTextChange>) =>
  source.slice(0, change.from) + change.insert + source.slice(change.to);

describe("minimalTextChange", () => {
  test("no cambia rangos cuando el texto es igual", () => {
    expect(minimalTextChange("texto", "texto")).toEqual({
      from: 5,
      to: 5,
      insert: "",
    });
  });

  test("limita el reemplazo a la parte que cambió", () => {
    const before = "antes\ncontenido viejo\ndespues";
    const after = "antes\ncontenido nuevo\ndespues";
    const change = minimalTextChange(before, after);

    expect(change).toEqual({
      from: 16,
      to: 20,
      insert: "nuev",
    });
    expect(apply(before, change)).toBe(after);
  });

  test("soporta inserciones y eliminaciones en los extremos", () => {
    const cases: [string, string][] = [
      ["abc", "Xabc"],
      ["abc", "abcX"],
      ["Xabc", "abc"],
      ["abcX", "abc"],
      ["", "nuevo"],
      ["texto", ""],
    ];
    for (const [before, after] of cases) {
      expect(apply(before, minimalTextChange(before, after))).toBe(after);
    }
  });

  test("no divide pares sustitutos al compartir solo la mitad de un emoji", () => {
    const smile = "\uD83D\uDE00";
    const grin = "\uD83D\uDE01";
    const cases: [string, string][] = [
      [smile, grin],
      [`a${smile}x`, `a${grin}x`],
      [`${smile}x`, `${smile}y`],
    ];
    for (const [before, after] of cases) {
      const change = minimalTextChange(before, after);
      expect(apply(before, change)).toBe(after);
      expect(before.slice(0, change.from)).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(before.slice(change.to)).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });
});
