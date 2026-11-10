import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./api.ts";

let base: string;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-api-")));
  root = join(base, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "note.md"), "# nota\n");
  await writeFile(join(root, "sub", "otra nota.md"), "contenido inicial");
  await writeFile(join(root, "img.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(base, "outside.md"), "secreto");
  await symlink(join(base, "outside.md"), join(root, "enlace.md"));
  await writeFile(join(root, ".git", "hidden.md"), "oculto");

  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);

  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: createRoutes(root, port),
    fetch: () => new Response("No encontrado", { status: 404 }),
  });
  origin = server.url.origin;
});

afterAll(async () => {
  server.stop(true);
  await rm(base, { recursive: true, force: true });
});

test("GET /api/tree lista Markdown visibles", async () => {
  const response = await fetch(`${origin}/api/tree`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ files: ["note.md", "sub/otra nota.md"] });
});

test("GET/PUT /api/file leen y guardan Markdown", async () => {
  const url = `${origin}/api/file?path=${encodeURIComponent("sub/otra nota.md")}`;
  const get = await fetch(url);
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toContain("text/plain");
  expect(await get.text()).toBe("contenido inicial");

  const put = await fetch(url, { method: "PUT", body: "# actualizado\n" });
  expect(put.status).toBe(204);
  expect(await Bun.file(join(root, "sub", "otra nota.md")).text()).toBe("# actualizado\n");
});

test("la API rechaza métodos, archivos y rutas que no admite", async () => {
  expect((await fetch(`${origin}/api/tree`, { method: "POST" })).status).toBe(404);
  expect((await fetch(`${origin}/api/file?path=img.svg`)).status).toBe(400);
  expect((await fetch(`${origin}/api/file`)).status).toBe(400);
  expect((await fetch(`${origin}/api/file?path=missing.md`)).status).toBe(404);
  expect((await fetch(`${origin}/api/file?path=../outside.md`)).status).toBe(403);
  expect((await fetch(`${origin}/api/file?path=enlace.md`)).status).toBe(403);
  expect((await fetch(`${origin}/api/file?path=.git/hidden.md`)).status).toBe(404);
  expect((await fetch(`${origin}/files/%2e%2e%2foutside.md`)).status).toBe(403);
  expect((await fetch(`${origin}/files/.git/hidden.md`)).status).toBe(404);
});

test("sirve estáticos dentro del raíz con sandbox y valida Host", async () => {
  const response = await fetch(`${origin}/files/img.svg`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toBe("sandbox");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toContain("<svg");

  const forbidden = await fetch(`${origin}/api/tree`, { headers: { Host: "evil.example" } });
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toEqual({ error: "Host no permitido." });
});
