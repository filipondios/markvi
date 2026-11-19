import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./api.ts";
import { createFileWatcher, type FileWatcher } from "./watch.ts";

let base: string;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let watcher: FileWatcher;
let origin: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-write-")));
  root = join(base, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(root, ".git"));
  await mkdir(join(base, "fuera"));
  await symlink(join(base, "fuera"), join(root, "enlace-fuera"));

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

const enc = encodeURIComponent;
const file = (path: string) => `${origin}/api/file?path=${enc(path)}`;
const exists = (path: string) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );
const post = (path: string, body = "", headers: Record<string, string> = {}) =>
  fetch(file(path), { method: "POST", body, headers });
const move = (from: unknown, to: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}/api/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ from, to }),
  });

// --- Crear ---------------------------------------------------------------

test("POST /api/file crea un archivo vacío y devuelve su ETag", async () => {
  const response = await post("nuevo.md");
  expect(response.status).toBe(201);
  expect(response.headers.get("etag")).toBeTruthy();
  expect(await readFile(join(root, "nuevo.md"), "utf8")).toBe("");

  const get = await fetch(file("nuevo.md"));
  expect(get.status).toBe(200);
  expect(get.headers.get("etag")).toBe(response.headers.get("etag"));
});

test("POST /api/file puede llevar contenido inicial y crea las carpetas", async () => {
  const response = await post("notas/2026/idea.md", "# Idea\n");
  expect(response.status).toBe(201);
  expect(await readFile(join(root, "notas", "2026", "idea.md"), "utf8")).toBe("# Idea\n");
});

test("POST /api/file nunca sobrescribe un archivo existente", async () => {
  await writeFile(join(root, "existe.md"), "original");
  const response = await post("existe.md", "otro");
  expect(response.status).toBe(409);
  expect(await readFile(join(root, "existe.md"), "utf8")).toBe("original");
});

test("POST /api/file rechaza rutas no válidas", async () => {
  expect((await post("nota.txt")).status).toBe(400);
  expect((await post("")).status).toBe(400);
  expect((await post(".oculto.md")).status).toBe(400);
  expect((await post(".git/x.md")).status).toBe(400);
  expect((await post("../fuera.md")).status).toBe(403);
  expect((await post("enlace-fuera/x.md")).status).toBe(403);
  expect(await exists("../fuera.md")).toBe(false);
  expect(await stat(join(base, "fuera")).then(() => true)).toBe(true);
  expect(await exists("enlace-fuera/x.md")).toBe(false);
});

// --- Borrar --------------------------------------------------------------

test("DELETE /api/file borra el archivo", async () => {
  await writeFile(join(root, "borrar.md"), "adiós");
  const response = await fetch(file("borrar.md"), { method: "DELETE" });
  expect(response.status).toBe(204);
  expect(await exists("borrar.md")).toBe(false);
  expect((await fetch(file("borrar.md"))).status).toBe(404);
});

test("DELETE /api/file devuelve 404 si no existe y rechaza lo que no es .md", async () => {
  expect((await fetch(file("no-existe.md"), { method: "DELETE" })).status).toBe(404);
  await writeFile(join(root, "dato.txt"), "x");
  expect((await fetch(file("dato.txt"), { method: "DELETE" })).status).toBe(400);
  expect(await exists("dato.txt")).toBe(true);
  expect((await fetch(file("../fuera.md"), { method: "DELETE" })).status).toBe(403);
});

test("DELETE /api/file respeta If-Match", async () => {
  await writeFile(join(root, "version.md"), "v1");
  const etag = (await fetch(file("version.md"))).headers.get("etag")!;
  await writeFile(join(root, "version.md"), "v2");

  const stale = await fetch(file("version.md"), { method: "DELETE", headers: { "If-Match": etag } });
  expect(stale.status).toBe(409);
  expect(await exists("version.md")).toBe(true);

  const current = (await fetch(file("version.md"))).headers.get("etag")!;
  const ok = await fetch(file("version.md"), { method: "DELETE", headers: { "If-Match": current } });
  expect(ok.status).toBe(204);
  expect(await exists("version.md")).toBe(false);
});

// --- Mover ---------------------------------------------------------------

test("POST /api/move renombra y conserva el contenido", async () => {
  await writeFile(join(root, "antes.md"), "contenido");
  const response = await move("antes.md", "despues.md");
  expect(response.status).toBe(204);
  expect(await exists("antes.md")).toBe(false);
  expect(await readFile(join(root, "despues.md"), "utf8")).toBe("contenido");
});

test("POST /api/move crea las carpetas del destino", async () => {
  await writeFile(join(root, "suelto.md"), "x");
  expect((await move("suelto.md", "carpeta/nueva/suelto.md")).status).toBe(204);
  expect(await readFile(join(root, "carpeta", "nueva", "suelto.md"), "utf8")).toBe("x");
});

test("POST /api/move no pisa un destino existente", async () => {
  await writeFile(join(root, "a.md"), "A");
  await writeFile(join(root, "b.md"), "B");
  expect((await move("a.md", "b.md")).status).toBe(409);
  expect(await readFile(join(root, "a.md"), "utf8")).toBe("A");
  expect(await readFile(join(root, "b.md"), "utf8")).toBe("B");
  expect((await move("a.md", "a.md")).status).toBe(409);
});

test("POST /api/move valida origen, destino y cuerpo", async () => {
  await writeFile(join(root, "m.md"), "m");
  expect((await move("no-existe.md", "x.md")).status).toBe(404);
  expect((await move("m.md", "m.txt")).status).toBe(400);
  expect((await move("m.md", ".oculto.md")).status).toBe(400);
  expect((await move("m.md", "../fuera.md")).status).toBe(403);
  expect((await move("m.md", "enlace-fuera/m.md")).status).toBe(403);
  expect((await move("../fuera.md", "m2.md")).status).toBe(403);
  expect((await move(3, "x.md")).status).toBe(400);
  expect((await move("m.md", undefined)).status).toBe(400);
  const broken = await fetch(`${origin}/api/move`, { method: "POST", body: "no es json" });
  expect(broken.status).toBe(400);
  expect(await exists("m.md")).toBe(true);
});

// --- Origen --------------------------------------------------------------

test("las escrituras desde otro origen se rechazan", async () => {
  const foreign = { Origin: "https://ejemplo.invalid" };
  expect((await post("csrf.md", "", foreign)).status).toBe(403);
  expect(await exists("csrf.md")).toBe(false);

  await writeFile(join(root, "victima.md"), "datos");
  expect((await move("victima.md", "robada.md", foreign)).status).toBe(403);
  expect((await fetch(file("victima.md"), { method: "DELETE", headers: foreign })).status).toBe(403);
  expect((await fetch(file("victima.md"), { method: "PUT", body: "x", headers: foreign })).status).toBe(403);
  expect(await readFile(join(root, "victima.md"), "utf8")).toBe("datos");
});

test("las escrituras desde el propio origen se aceptan", async () => {
  const same = { Origin: origin };
  expect((await post("propio.md", "", same)).status).toBe(201);
  expect((await move("propio.md", "propio2.md", same)).status).toBe(204);
  expect((await fetch(file("propio2.md"), { method: "DELETE", headers: same })).status).toBe(204);
});

// --- Búsqueda ------------------------------------------------------------

test("GET /api/search devuelve coincidencias con ruta, línea y rangos", async () => {
  await writeFile(join(root, "busca.md"), "uno\nla Aguja\ntres");
  const response = await fetch(`${origin}/api/search?q=${enc("Aguja")}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as {
    results: { path: string; line: number; text: string; matches: number[][] }[];
    truncated: boolean;
  };
  expect(body.truncated).toBe(false);
  expect(body.results).toContainEqual({ path: "busca.md", line: 2, text: "la Aguja", matches: [[3, 8]] });
});

test("GET /api/search sin consulta devuelve vacío y rechaza consultas enormes", async () => {
  expect(await (await fetch(`${origin}/api/search`)).json()).toEqual({ results: [], truncated: false });
  expect(await (await fetch(`${origin}/api/search?q=%20%20`)).json()).toEqual({
    results: [],
    truncated: false,
  });
  expect((await fetch(`${origin}/api/search?q=${"a".repeat(500)}`)).status).toBe(400);
});

test("GET /api/search comprueba el Host", async () => {
  const response = await fetch(`${origin}/api/search?q=x`, { headers: { Host: "malo.example" } });
  expect(response.status).toBe(403);
});

// --- Guardado atómico y concurrente ------------------------------------------

const put = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(file(path), { method: "PUT", body, headers });
const temporaries = async () => (await readdir(root)).filter((name) => name.endsWith(".tmp"));

test("PUT sustituye el contenido, devuelve el ETag nuevo y no deja temporales", async () => {
  const created = await post("guardar.md", "viejo\n");
  const response = await put("guardar.md", "nuevo\n", { "If-Match": created.headers.get("etag")! });
  expect(response.status).toBe(204);
  expect(await readFile(join(root, "guardar.md"), "utf8")).toBe("nuevo\n");
  expect((await fetch(file("guardar.md"))).headers.get("etag")).toBe(response.headers.get("etag"));
  expect(await temporaries()).toEqual([]);
});

test("PUT con el mismo If-Match a la vez: solo uno gana, el resto recibe 409", async () => {
  const created = await post("carrera.md", "inicial\n");
  const etag = created.headers.get("etag")!;

  // Cuerpos grandes: con cuerpos de pocos bytes las peticiones se atienden casi en
  // serie y la carrera no se manifiesta (sin el candado, aquí ganan las 20).
  const bodyFor = (i: number) => `escritor ${i}\n`.padEnd(400_000, "x");
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) => put("carrera.md", bodyFor(i), { "If-Match": etag })),
  );
  const statuses = responses.map((response) => response.status);
  expect(statuses.filter((status) => status === 204)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409)).toHaveLength(19);

  // El contenido es el del único escritor que ganó, completo.
  const winner = statuses.indexOf(204);
  expect(await readFile(join(root, "carrera.md"), "utf8")).toBe(bodyFor(winner));
  expect(await temporaries()).toEqual([]);
});

test("PUT a un enlace simbólico del raíz escribe el destino y conserva el enlace", async () => {
  await writeFile(join(root, "real.md"), "real\n");
  await symlink(join(root, "real.md"), join(root, "enlace.md"));

  const response = await put("enlace.md", "por el enlace\n");
  expect(response.status).toBe(204);
  expect((await lstat(join(root, "enlace.md"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(root, "real.md"), "utf8")).toBe("por el enlace\n");
});

test("PUT sin create a un archivo que no existe no lo crea", async () => {
  const response = await put("fantasma.md", "x");
  expect(response.status).toBe(404);
  expect(await exists("fantasma.md")).toBe(false);
});

test("PUT con create=1 recrea un archivo borrado", async () => {
  const response = await fetch(`${file("recreado.md")}&create=1`, { method: "PUT", body: "de nuevo\n" });
  expect(response.status).toBe(204);
  expect(await readFile(join(root, "recreado.md"), "utf8")).toBe("de nuevo\n");
});

test("POST a la vez sobre la misma ruta: uno crea (201) y el resto recibe 409", async () => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => post("doble.md", `creador ${i}\n`)),
  );
  const statuses = responses.map((response) => response.status);
  expect(statuses.filter((status) => status === 201)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409)).toHaveLength(9);
  expect(await readFile(join(root, "doble.md"), "utf8")).toBe(`creador ${statuses.indexOf(201)}\n`);
  expect(await temporaries()).toEqual([]);
});
