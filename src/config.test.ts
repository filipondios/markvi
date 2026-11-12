import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./api.ts";
import {
  defaultConfig,
  loadConfig,
  parseConfig,
  parseFont,
  parseSequence,
  resolveConfigPath,
} from "./config.ts";
import { createFileWatcher } from "./watch.ts";

const keysOf = (config: ReturnType<typeof defaultConfig>) =>
  config.leaderBindings.map((binding) => `${binding.keys.join(" ")}=${binding.action}`).sort();

test("sin archivo o vacío: valores por omisión y sin avisos", () => {
  expect(parseConfig(null)).toEqual({ config: defaultConfig(), warnings: [] });
  expect(parseConfig("  \n")).toEqual({ config: defaultConfig(), warnings: [] });
  expect(keysOf(defaultConfig())).toEqual([
    "/=grep",
    "a=alternate",
    "b=backlinks",
    "f=find",
    "r=recent",
    "t=toc",
    "x=close",
  ]);
});

test("lee tema, fuente, líder y opciones del editor", () => {
  const { config, warnings } = parseConfig(`
    leader = ","
    theme = "dark"
    font = "JetBrains Mono, Fira Code, monospace"

    [editor]
    number = false
    relativenumber = true
    scrolloff = 5
  `);
  expect(warnings).toEqual([]);
  expect(config.leader).toBe(",");
  expect(config.theme).toBe("dark");
  expect(config.font).toBe('"JetBrains Mono", "Fira Code", monospace');
  expect(config.editor).toEqual({ number: false, relativenumber: true, scrolloff: 5 });
});

test('"space" es la barra espaciadora y las letras no sirven de líder', () => {
  expect(parseConfig('leader = "space"').config.leader).toBe(" ");

  const letter = parseConfig('leader = "j"');
  expect(letter.config.leader).toBe(" ");
  expect(letter.warnings).toHaveLength(1);
  expect(parseConfig('leader = "ab"').warnings).toHaveLength(1);
  expect(parseConfig("leader = 3").warnings).toHaveLength(1);
});

test("valores no válidos se ignoran con aviso y el resto sigue valiendo", () => {
  const { config, warnings } = parseConfig(`
    theme = "azul"
    font = "Mono; background: red"
    colour = 1

    [editor]
    number = "yes"
    scrolloff = -1
    tabs = 4
  `);
  expect(config.theme).toBe("auto");
  expect(config.font).toBeNull();
  expect(config.editor).toEqual(defaultConfig().editor);
  expect(warnings).toHaveLength(6);
  expect(warnings.join("\n")).toContain('"colour"');
  expect(warnings.join("\n")).toContain('"editor.tabs"');
});

test("error de sintaxis TOML: valores por omisión y un aviso", () => {
  const { config, warnings } = parseConfig("theme = = dark");
  expect(config).toEqual(defaultConfig());
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toStartWith("Syntax error");
});

test("parseSequence", () => {
  expect(parseSequence("f")).toEqual(["f"]);
  expect(parseSequence("gt")).toEqual(["g", "t"]);
  expect(parseSequence("g t")).toEqual(["g", "t"]);
  expect(parseSequence("space")).toEqual([" "]);
  expect(parseSequence("g space")).toEqual(["g", " "]);
  expect(parseSequence("")).toBeNull();
  expect(parseSequence("abcde")).toBeNull();
  expect(parseSequence("Enter x")).toBeNull();
});

test("parseFont cita los nombres y deja pasar las genéricas", () => {
  expect(parseFont("Cascadia Code")).toBe('"Cascadia Code"');
  expect(parseFont("'Fira Code', Monospace")).toBe('"Fira Code", monospace');
  expect(parseFont("")).toBeNull();
  expect(parseFont('a"; } body { x: y')).toBeNull();
  expect(parseFont("url(http://x)")).toBeNull();
});

test("keymap.leader: redefine, añade, quita y admite comandos ex", () => {
  const { config, warnings } = parseConfig(`
    [keymap.leader]
    f = "grep"
    x = "none"
    n = ":e diario.md"
    "g t" = "toc"
    zz = "recent"
  `);
  expect(warnings).toEqual([]);
  expect(keysOf(config)).toEqual([
    "/=grep",
    "a=alternate",
    "b=backlinks",
    "f=grep",
    "g t=toc",
    "n=:e diario.md",
    "r=recent",
    "t=toc",
    "z z=recent",
  ]);
});

test("keymap.leader: acciones y secuencias no válidas avisan", () => {
  const { config, warnings } = parseConfig(`
    [keymap.leader]
    q = "explotar"
    w = 3
    "" = "find"
    ":" = ":"
  `);
  expect(warnings).toHaveLength(4);
  expect(keysOf(config)).toEqual(keysOf(defaultConfig()));
});

test("keymap.leader: una secuencia tapada por otra se descarta con aviso", () => {
  const blocked = parseConfig(`
    [keymap.leader]
    ff = "grep"
  `);
  expect(blocked.warnings).toHaveLength(1);
  expect(blocked.warnings[0]).toContain('"f" = "none"');
  expect(keysOf(blocked.config)).toEqual(keysOf(defaultConfig()));

  const freed = parseConfig(`
    [keymap.leader]
    f = "none"
    ff = "grep"
    fg = "find"
  `);
  expect(freed.warnings).toEqual([]);
  expect(keysOf(freed.config)).toContain("f f=grep");
  expect(keysOf(freed.config)).toContain("f g=find");
  expect(keysOf(freed.config).some((entry) => entry.startsWith("f="))).toBe(false);
});

test("keymap.view reasigna teclas simples", () => {
  const { config, warnings } = parseConfig(`
    [keymap.view]
    J = "j"
    n = "n"
    "ab" = "j"
    k = "space"
  `);
  expect(config.viewRemap).toEqual({ J: "j" });
  expect(warnings).toHaveLength(2);
});

test("keymap.normal / insert / visual se convierten en mapeos de Vim", () => {
  const { config, warnings } = parseConfig(`
    [keymap.insert]
    jk = "<Esc>"

    [keymap.normal]
    H = "^"
    L = "$"

    [keymap.visual]
    bad = ""

    [keymap.otro]
    a = "b"
  `);
  expect(config.vimMappings).toEqual([
    { context: "normal", lhs: "H", rhs: "^" },
    { context: "normal", lhs: "L", rhs: "$" },
    { context: "insert", lhs: "jk", rhs: "<Esc>" },
  ]);
  expect(warnings).toHaveLength(2);
});

test("resolveConfigPath: opción, variable de entorno, XDG y ~/.config", () => {
  expect(resolveConfigPath("/tmp/a.toml", {})).toBe("/tmp/a.toml");
  expect(resolveConfigPath(undefined, { MARKVI_CONFIG: "/tmp/b.toml" })).toBe("/tmp/b.toml");
  expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/markvi/config.toml");
  expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: "relativa" })).toEndWith(
    ".config/markvi/config.toml",
  );
  expect(resolveConfigPath(undefined, {})).toEndWith(".config/markvi/config.toml");
});

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let watcher: ReturnType<typeof createFileWatcher>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "markvi-config-"));
  await writeFile(join(dir, "config.toml"), 'theme = "light"\nnope = 1\n');

  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);

  watcher = createFileWatcher(dir);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: createRoutes(dir, port, watcher, join(dir, "config.toml")),
    fetch: () => new Response("No encontrado", { status: 404 }),
  });
});

afterAll(async () => {
  server.stop(true);
  watcher.close();
  await rm(dir, { recursive: true, force: true });
});

test("loadConfig distingue archivo ausente, presente y con avisos", async () => {
  const missing = await loadConfig(join(dir, "no-existe.toml"));
  expect(missing.exists).toBe(false);
  expect(missing.warnings).toEqual([]);
  expect(missing.config).toEqual(defaultConfig());

  const present = await loadConfig(join(dir, "config.toml"));
  expect(present.exists).toBe(true);
  expect(present.config.theme).toBe("light");
  expect(present.warnings).toHaveLength(1);
});

test("GET /api/config devuelve la configuración resuelta y relee el archivo", async () => {
  const get = async () =>
    (await (await fetch(`${server.url.origin}/api/config`)).json()) as Awaited<ReturnType<typeof loadConfig>>;

  expect((await get()).config.theme).toBe("light");
  await writeFile(join(dir, "config.toml"), 'theme = "dark"\n');
  const after = await get();
  expect(after.config.theme).toBe("dark");
  expect(after.warnings).toEqual([]);
  expect(after.path).toBe(join(dir, "config.toml"));
});

test("el archivo de configuración no se sirve como archivo del directorio", async () => {
  expect((await fetch(`${server.url.origin}/api/file?path=config.toml`)).status).toBe(400);
});
