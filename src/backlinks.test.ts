import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./api.ts";
import { extractLinks, findBacklinks, markdownTarget, searchBacklinks } from "./backlinks.ts";
import { createFileWatcher, type FileWatcher } from "./watch.ts";
import { createWikiIndex } from "./wiki.ts";

test("extractLinks encuentra enlaces wiki y Markdown con su rango", () => {
  const links = extractLinks("ver [[Nota]] y [texto](otra.md#sec) fin");
  expect(links.map((l) => [l.kind, l.target, l.line, l.range])).toEqual([
    ["wiki", "Nota", 1, [4, 12]],
    ["markdown", "otra.md#sec", 1, [15, 35]],
  ]);
});

test("extractLinks ignora código vallado, código en línea e imágenes", () => {
  const source = [
    "```md",
    "[[En código]]",
    "```",
    "~~~~",
    "[[Otro]]",
    "```", // no cierra una valla de ~
    "~~~~",
    "`[[En línea]]` y ``[[doble `tick`]]``",
    "![img](a.md)",
    "[[Real]]",
  ].join("\n");
  const links = extractLinks(source);
  expect(links.map((l) => [l.target, l.line])).toEqual([["Real", 10]]);
});

test("extractLinks cuenta bien las líneas con CRLF", () => {
  expect(extractLinks("a\r\n\r\n[[X]]").map((l) => l.line)).toEqual([3]);
});

test("markdownTarget resuelve rutas relativas y descarta lo que no es un .md local", () => {
  expect(markdownTarget("../TODO.md", "notas/otra.md")).toBe("TODO.md");
  expect(markdownTarget("./b.md#x", "notas/a.md")).toBe("notas/b.md");
  expect(markdownTarget("/notas/b.md", "x/a.md")).toBe("notas/b.md");
  expect(markdownTarget("a%20b.md", "")).toBe("a b.md");
  expect(markdownTarget("https://x.org/a.md", "a.md")).toBeNull();
  expect(markdownTarget("mailto:a@b.c", "a.md")).toBeNull();
  expect(markdownTarget("#sec", "a.md")).toBeNull();
  expect(markdownTarget("img.png", "a.md")).toBeNull();
  expect(markdownTarget("../../x.md", "a/b.md")).toBeNull();
});

const files = ["a.md", "notas/b.md", "notas/c.md"];
const index = createWikiIndex(files);

test("findBacklinks agrupa por línea y respeta el origen del enlace", () => {
  const source = ["sin enlaces", "[[a]] y [de nuevo](../a.md)", "[[a#Sec|alias]]", "[[c]]"].join("\n");
  const { hits, truncated } = findBacklinks(source, "notas/b.md", "a.md", index);
  expect(truncated).toBe(false);
  expect(hits.map((h) => [h.path, h.line, h.matches.length])).toEqual([
    ["notas/b.md", 2, 2],
    ["notas/b.md", 3, 1],
  ]);
  expect(hits[0]!.text).toBe("[[a]] y [de nuevo](../a.md)");
  expect(hits[0]!.matches).toEqual([
    [0, 5],
    [8, 27],
  ]);
});

test("findBacklinks ignora los enlaces del propio archivo", () => {
  expect(findBacklinks("[[a]] [[#x]]", "a.md", "a.md", index).hits).toEqual([]);
});

test("findBacklinks respeta el límite por archivo", () => {
  const source = Array.from({ length: 5 }, () => "[[a]]").join("\n");
  const { hits, truncated } = findBacklinks(source, "notas/b.md", "a.md", index, 3);
  expect(hits).toHaveLength(3);
  expect(truncated).toBe(true);
});

let base: string;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let watcher: FileWatcher;
let origin: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-backlinks-")));
  root = join(base, "root");
  await mkdir(join(root, "notas"), { recursive: true });
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "inicio.md"), "# Inicio\n");
  await writeFile(join(root, "notas", "uno.md"), "ver [[inicio]]\notra línea\n");
  await writeFile(join(root, "notas", "dos.md"), "[volver](../inicio.md)\n```\n[[inicio]]\n```\n");
  await writeFile(join(root, "notas", "tres.md"), "nada que ver\n");
  await writeFile(join(root, ".git", "oculto.md"), "[[inicio]]\n");

  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);

  watcher = createFileWatcher(root);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: createRoutes(root, port, watcher),
    fetch: () => new Response("No encontrado", { status: 404 }),
  });
  origin = server.url.origin;
});

afterAll(async () => {
  server.stop(true);
  watcher.close();
  await rm(base, { recursive: true, force: true });
});

test("searchBacklinks recorre el directorio", async () => {
  const { results, truncated } = await searchBacklinks(root, "inicio.md");
  expect(truncated).toBe(false);
  expect(results.map((hit) => [hit.path, hit.line])).toEqual([
    ["notas/dos.md", 1],
    ["notas/uno.md", 1],
  ]);
});

test("GET /api/backlinks devuelve las líneas que enlazan al archivo", async () => {
  const response = await fetch(`${origin}/api/backlinks?path=${encodeURIComponent("inicio.md")}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as { results: { path: string; line: number }[] };
  expect(body.results.map((hit) => `${hit.path}:${hit.line}`)).toEqual([
    "notas/dos.md:1",
    "notas/uno.md:1",
  ]);
});

test("GET /api/backlinks acepta rutas con ./ y valida el archivo y el Host", async () => {
  const url = (path: string) => `${origin}/api/backlinks?path=${encodeURIComponent(path)}`;
  const body = (await (await fetch(url("./inicio.md"))).json()) as { results: unknown[] };
  expect(body.results).toHaveLength(2);
  expect((await fetch(url("no-existe.md"))).status).toBe(404);
  expect((await fetch(url("../fuera.md"))).status).toBe(403);
  expect((await fetch(`${origin}/api/backlinks`)).status).toBe(400);
  expect(
    (await fetch(url("inicio.md"), { headers: { Host: "malo.example" } })).status,
  ).toBe(403);
});
