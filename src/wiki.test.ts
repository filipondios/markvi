import { expect, test } from "bun:test";
import {
  createWikiIndex,
  headingSlug,
  joinRelative,
  matchWikiLink,
  wikiGlobalRegExp,
  wikiLabel,
  wikiStartRegExp,
} from "./wiki.ts";

const parse = (text: string) => {
  const match = wikiStartRegExp().exec(text);
  return match ? matchWikiLink(match) : null;
};

test("la sintaxis admite nombre, sección y alias", () => {
  expect(parse("[[Nota]]")).toEqual({ target: "Nota", heading: "", alias: "" });
  expect(parse("[[Nota#Título]]")).toEqual({ target: "Nota", heading: "Título", alias: "" });
  expect(parse("[[#Título]]")).toEqual({ target: "", heading: "Título", alias: "" });
  expect(parse("[[Nota|texto]]")).toEqual({ target: "Nota", heading: "", alias: "texto" });
  expect(parse("[[ Nota # Sec | alias ]]")).toEqual({ target: "Nota", heading: "Sec", alias: "alias" });
});

test("lo que no es un enlace no se reconoce", () => {
  expect(parse("[[]]")).toBeNull();
  expect(parse("[[|solo alias]]")).toBeNull();
  expect(parse("[[abierto")).toBeNull();
  expect(parse("[[a\nb]]")).toBeNull();
  expect(parse("[[a[b]]")).toBeNull();
  expect(parse("texto [[Nota]]")).toBeNull();
});

test("la expresión global encuentra todos los enlaces con su posición", () => {
  const text = "uno [[A]] dos [[B|b]] tres";
  const found = [...text.matchAll(wikiGlobalRegExp())].map((m) => [m.index, m[0]]);
  expect(found).toEqual([
    [4, "[[A]]"],
    [14, "[[B|b]]"],
  ]);
});

test("el texto visible es el alias o «Nota > Título»", () => {
  expect(wikiLabel({ target: "A", heading: "", alias: "" })).toBe("A");
  expect(wikiLabel({ target: "A", heading: "H", alias: "" })).toBe("A > H");
  expect(wikiLabel({ target: "", heading: "H", alias: "" })).toBe("H");
  expect(wikiLabel({ target: "A", heading: "H", alias: "x" })).toBe("x");
});

test("headingSlug coincide con los ids del render", () => {
  expect(headingSlug("  Mi Título: ¡Hola!  ")).toBe("mi-título-hola");
  expect(headingSlug("a   b_c-d")).toBe("a-b_c-d");
});

test("joinRelative resuelve . y .. sin salir de la raíz", () => {
  expect(joinRelative("a/b/", "../c.md")).toBe("a/c.md");
  expect(joinRelative("a/", "./x/../y")).toBe("a/y");
  expect(joinRelative("", "x.md")).toBe("x.md");
  expect(joinRelative("a/", "../../x")).toBeNull();
});

const files = ["inicio.md", "notas/Idea.md", "notas/otra.md", "diario/2026/idea.md", "TODO.md"];
const index = createWikiIndex(files);

test("resuelve por nombre sin distinguir mayúsculas ni extensión", () => {
  expect(index.resolve("todo", "inicio.md")).toBe("TODO.md");
  expect(index.resolve("TODO.md", "inicio.md")).toBe("TODO.md");
  expect(index.resolve("  otra  ", "inicio.md")).toBe("notas/otra.md");
  expect(index.resolve("no existe", "inicio.md")).toBeNull();
});

test("un nombre repetido prefiere la misma carpeta, luego el menos profundo", () => {
  expect(index.resolve("idea", "diario/2026/hoy.md")).toBe("diario/2026/idea.md");
  expect(index.resolve("idea", "notas/otra.md")).toBe("notas/Idea.md");
  expect(index.resolve("idea", "inicio.md")).toBe("notas/Idea.md");
});

test("una ruta parcial desambigua por sufijo", () => {
  expect(index.resolve("notas/idea", "diario/2026/idea.md")).toBe("notas/Idea.md");
  expect(index.resolve("2026/idea", "inicio.md")).toBe("diario/2026/idea.md");
});

test("/, ./ y ../ son rutas exactas", () => {
  expect(index.resolve("/notas/otra", "diario/2026/idea.md")).toBe("notas/otra.md");
  expect(index.resolve("/otra", "inicio.md")).toBeNull();
  expect(index.resolve("../otra", "notas/Idea.md")).toBeNull();
  expect(index.resolve("./otra", "notas/Idea.md")).toBe("notas/otra.md");
  expect(index.resolve("../inicio", "notas/Idea.md")).toBe("inicio.md");
  expect(index.resolve("../../inicio", "notas/Idea.md")).toBeNull();
});

test("sin destino (solo sección) apunta al propio documento", () => {
  expect(index.resolve("", "notas/otra.md")).toBe("notas/otra.md");
});

test("sin archivos nada se resuelve", () => {
  expect(createWikiIndex([]).resolve("a", "x.md")).toBeNull();
});
