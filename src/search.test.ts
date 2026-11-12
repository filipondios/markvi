import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchMarkdown, searchText } from "./search.ts";

test("searchText encuentra todas las coincidencias de una línea", () => {
  const { hits } = searchText("a.md", "uno\nfoo bar foo\ndos", "foo", 10);
  expect(hits).toEqual([{ path: "a.md", line: 2, text: "foo bar foo", matches: [[0, 3], [8, 11]] }]);
});

test("ignora mayúsculas salvo que la consulta tenga alguna", () => {
  const text = "Todo\ntodo\nTODO";
  expect(searchText("a.md", text, "todo", 10).hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
  expect(searchText("a.md", text, "Todo", 10).hits.map((hit) => hit.line)).toEqual([1]);
  expect(searchText("a.md", text, "TODO", 10).hits.map((hit) => hit.line)).toEqual([3]);
});

test("la consulta es texto literal, no una expresión regular", () => {
  const text = "a.b\naxb\n(x)\n[y]";
  expect(searchText("a.md", text, "a.b", 10).hits.map((hit) => hit.line)).toEqual([1]);
  expect(searchText("a.md", text, "(x)", 10).hits.map((hit) => hit.line)).toEqual([3]);
  expect(searchText("a.md", text, "[y]", 10).hits.map((hit) => hit.line)).toEqual([4]);
});

test("quita la sangría y desplaza los rangos", () => {
  const { hits } = searchText("a.md", "    - [ ] comprar pan", "pan", 10);
  expect(hits[0]!.text).toBe("- [ ] comprar pan");
  const [from, to] = hits[0]!.matches[0]!;
  expect(hits[0]!.text.slice(from, to)).toBe("pan");
});

test("cuenta bien las líneas con CRLF", () => {
  const { hits } = searchText("a.md", "uno\r\ndos\r\ntres objetivo", "objetivo", 10);
  expect(hits.map((hit) => hit.line)).toEqual([3]);
  expect(hits[0]!.text).toBe("tres objetivo");
});

test("recorta las líneas largas alrededor de la coincidencia", () => {
  const line = `${"a".repeat(300)} aguja ${"b".repeat(300)}`;
  const { hits } = searchText("a.md", line, "aguja", 10);
  const hit = hits[0]!;
  expect(hit.text.length).toBeLessThanOrEqual(242);
  expect(hit.text.startsWith("…")).toBe(true);
  expect(hit.text.endsWith("…")).toBe(true);
  const [from, to] = hit.matches[0]!;
  expect(hit.text.slice(from, to)).toBe("aguja");
});

test("perFile limita las coincidencias y avisa de que hay más", () => {
  const text = Array.from({ length: 10 }, () => "foo").join("\n");
  const limited = searchText("a.md", text, "foo", 3);
  expect(limited.hits).toHaveLength(3);
  expect(limited.truncated).toBe(true);
  expect(searchText("a.md", text, "foo", 10).truncated).toBe(false);
});

let base: string;
let root: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-search-")));
  root = join(base, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "a.md"), "# Título\nla aguja está aquí\n");
  await writeFile(join(root, "sub", "b.md"), "sin nada\nOtra Aguja\n");
  await writeFile(join(root, "c.txt"), "aguja en un txt\n");
  await writeFile(join(root, ".git", "x.md"), "aguja oculta\n");
  await writeFile(join(root, "node_modules", "y.md"), "aguja ignorada\n");
  await writeFile(join(root, "grande.md"), `aguja\n${"x".repeat(5000)}`);
});

afterAll(() => rm(base, { recursive: true, force: true }));

test("searchMarkdown recorre los .md visibles y devuelve ruta y línea", async () => {
  const { results, truncated } = await searchMarkdown(root, "aguja");
  expect(truncated).toBe(false);
  expect(results.map((hit) => `${hit.path}:${hit.line}`)).toEqual([
    "a.md:2",
    "grande.md:1",
    "sub/b.md:2",
  ]);
});

test("searchMarkdown respeta el límite máximo de archivo y de resultados", async () => {
  const small = await searchMarkdown(root, "aguja", { maxFileBytes: 1000 });
  expect(small.results.map((hit) => hit.path)).toEqual(["a.md", "sub/b.md"]);

  const limited = await searchMarkdown(root, "aguja", { limit: 1 });
  expect(limited.results).toHaveLength(1);
  expect(limited.truncated).toBe(true);
});

test("una consulta vacía no devuelve nada", async () => {
  expect(await searchMarkdown(root, "   ")).toEqual({ results: [], truncated: false });
});
