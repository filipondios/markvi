import { describe, expect, test } from "bun:test";
import { fuzzyMatch, fuzzySearch, fuzzySearchItems } from "./fuzzy.ts";

describe("fuzzyMatch", () => {
  test("sin consulta coincide con cualquier ruta", () => {
    expect(fuzzyMatch("", "notas/otra.md")).toEqual({ score: 0, positions: [] });
  });

  test("devuelve null si la consulta no es una subsecuencia", () => {
    expect(fuzzyMatch("xyz", "notas/otra.md")).toBeNull();
    expect(fuzzyMatch("demasiado larga", "corta.md")).toBeNull();
  });

  test("encuentra subsecuencias y devuelve sus posiciones", () => {
    const match = fuzzyMatch("fnd", "public/finder.ts");
    expect(match).not.toBeNull();
    expect(match!.positions).toEqual([7, 9, 10]);
  });

  test("ignora mayúsculas salvo smart case", () => {
    expect(fuzzyMatch("todo", "TODO.md")?.positions).toEqual([0, 1, 2, 3]);
    expect(fuzzyMatch("TODO", "TODO.md")).not.toBeNull();
    expect(fuzzyMatch("ToDo", "TODO.md")).toBeNull();
  });

  test("premia las coincidencias contiguas y al inicio de palabra", () => {
    const contiguous = fuzzyMatch("abc", "abc.md")!.score;
    const separated = fuzzyMatch("abc", "a-b-c.md")!.score;
    const scattered = fuzzyMatch("abc", "xaxbxc.md")!.score;

    expect(contiguous).toBeGreaterThan(separated);
    expect(separated).toBeGreaterThan(scattered);
  });

  test("premia el nombre del archivo frente a una coincidencia dispersa", () => {
    const near = fuzzyMatch("otra", "notas/otra.md")!.score;
    const far = fuzzyMatch("otra", "xotxrxa.md")!.score;
    expect(near).toBeGreaterThan(far);
  });
});

describe("fuzzySearch", () => {
  test("sin consulta conserva el orden recibido", () => {
    expect(fuzzySearch("", ["b.md", "a.md"]).map((result) => result.path)).toEqual([
      "b.md",
      "a.md",
    ]);
  });

  test("varias palabras se combinan con AND", () => {
    const files = ["notas/otra.md", "notas/uno.md", "otra.md"];
    expect(fuzzySearch("notas otra", files).map((result) => result.path)).toEqual([
      "notas/otra.md",
    ]);
    expect(fuzzySearch("   ", files)).toHaveLength(3);
  });

  test("une y ordena las posiciones de todos los términos", () => {
    const [result] = fuzzySearch("no otra", ["notas/otra.md"]);
    expect(result!.positions).toEqual([0, 1, 6, 7, 8, 9]);
  });

  test("filtra, ordena por puntuación y conserva el path original", () => {
    const results = fuzzySearch("todo", ["example/TODO.md", "notas/otra.md", "README.md"]);
    expect(results.map((result) => result.path)).toEqual(["example/TODO.md"]);
    expect(results[0]!.positions).toEqual([8, 9, 10, 11]);
  });

  test("desempata por ruta cuando la puntuación es igual", () => {
    const results = fuzzySearch("md", ["b.md", "a.md"]);
    expect(results.map((result) => result.path)).toEqual(["a.md", "b.md"]);
  });
});

describe("fuzzySearchItems", () => {
  test("busca sobre un texto propio y devuelve el elemento original", () => {
    const items = [
      { title: "Introducción", line: 1 },
      { title: "Instalación", line: 10 },
      { title: "Uso", line: 20 },
    ];
    const results = fuzzySearchItems("inst", items, (item) => item.title);
    expect(results.map((result) => result.item.line)).toEqual([10]);
    expect(results[0]!.positions).toEqual([0, 1, 2, 3]);
  });

  test("sin consulta conserva el orden y no resalta nada", () => {
    const items = ["b", "a"];
    expect(fuzzySearchItems("", items, (item) => item)).toEqual([
      { item: "b", score: 0, positions: [] },
      { item: "a", score: 0, positions: [] },
    ]);
  });
});
