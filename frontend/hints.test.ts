import { expect, test } from "bun:test";
import { hintLabels } from "./hints.ts";

test("genera etiquetas de una letra para pocos enlaces", () => {
  expect(hintLabels(0)).toEqual([]);
  expect(hintLabels(3)).toEqual(["a", "s", "d"]);
  expect(hintLabels(26)).toHaveLength(26);
  expect(new Set(hintLabels(26)).size).toBe(26);
});

test("con más de 26 enlaces usa dos letras y no repite", () => {
  const labels = hintLabels(30);
  expect(labels).toHaveLength(30);
  expect(labels.every((label) => label.length === 2)).toBe(true);
  expect(new Set(labels).size).toBe(30);
  expect(labels[0]).toBe("aa");
});
