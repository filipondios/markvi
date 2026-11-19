import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./api.ts";
import { listMarkdown, listMarkdownEntries, resolveEntry, uniquePaths } from "./files.ts";
import { createFileWatcher, type DiskEvent, type FileWatcher } from "./watch.ts";

let base: string;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let watcher: FileWatcher;
let origin: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markvi-links-")));
  root = join(base, "root");
  await mkdir(join(root, "realdir"), { recursive: true });
  await mkdir(join(root, "sub"));
  await mkdir(join(root, ".oculta"));
  await mkdir(join(base, "fuera-dir"));

  await writeFile(join(root, "real.md"), "# Real NEEDLE\n");
  await writeFile(join(root, "realdir", "a.md"), "# En carpeta NEEDLE\n");
  await writeFile(join(root, "datos.txt"), "texto NEEDLE\n");
  await writeFile(join(root, ".oculta", "h.md"), "# Oculto\n");
  await writeFile(join(base, "fuera.md"), "# Fuera NEEDLE\n");
  await writeFile(join(base, "fuera-dir", "o.md"), "# Fuera dir NEEDLE\n");

  await symlink("real.md", join(root, "link.md")); // a un archivo, dentro
  await symlink("realdir", join(root, "linkdir")); // a una carpeta, dentro
  await symlink("datos.txt", join(root, "txtlink.md")); // el destino no es .md
  await symlink("..", join(root, "realdir", "volver")); // bucle: apunta al raíz
  await symlink(".", join(root, "realdir", "yo")); // bucle: apunta a sí misma
  await symlink(join(base, "fuera.md"), join(root, "fuera.md")); // sale del raíz
  await symlink(join(base, "fuera-dir"), join(root, "fuera-dir")); // sale del raíz
  await symlink("nada.md", join(root, "roto.md")); // roto
  await symlink(".oculta/h.md", join(root, "haciaoculta.md")); // destino oculto

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
const move = (from: string, to: string) =>
  fetch(`${origin}/api/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
const waitFor = async (check: () => boolean, timeout = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("tiempo de espera agotado");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// --- Listado ------------------------------------------------------------------

test("el listado incluye los enlaces que resuelven dentro del raíz", async () => {
  const paths = (await listMarkdown(root)).sort();
  expect(paths).toEqual(
    ["link.md", "linkdir/a.md", "real.md", "realdir/a.md"].sort(),
  );
});

test("no lista enlaces que salen del raíz, rotos, ocultos ni bucles (y termina)", async () => {
  const paths = await listMarkdown(root);
  for (const excluded of ["fuera.md", "roto.md", "haciaoculta.md", "txtlink.md"]) {
    expect(paths).not.toContain(excluded);
  }
  expect(paths.some((path) => path.startsWith("fuera-dir/"))).toBe(false);
  expect(paths.some((path) => path.includes("volver") || path.includes("/yo/"))).toBe(false);
});

test("cada entrada por enlace indica su ruta real", async () => {
  const entries = new Map((await listMarkdownEntries(root)).map((entry) => [entry.path, entry.real]));
  expect(entries.get("real.md")).toBeUndefined();
  expect(entries.get("realdir/a.md")).toBeUndefined();
  expect(entries.get("link.md")).toBe("real.md");
  expect(entries.get("linkdir/a.md")).toBe("realdir/a.md");
});

test("todo lo que se lista se puede leer, y lo que no se lista y sale del raíz se rechaza", async () => {
  for (const path of await listMarkdown(root)) {
    expect((await fetch(file(path))).status).toBe(200);
  }
  expect((await fetch(file("fuera.md"))).status).toBe(403);
  expect((await fetch(file("fuera-dir/o.md"))).status).toBe(403);
  // Un enlace .md hacia un archivo que no es Markdown no se lista ni se sirve.
  expect((await fetch(file("txtlink.md"))).status).toBe(400);
});

test("uniquePaths lee una sola vez los archivos con varias rutas", async () => {
  const unique = uniquePaths(await listMarkdownEntries(root)).sort();
  expect(unique).toEqual(["real.md", "realdir/a.md"]);
});

test("/api/tree y la búsqueda ven los enlaces, sin resultados duplicados", async () => {
  const tree = (await (await fetch(`${origin}/api/tree`)).json()) as { files: string[] };
  expect(tree.files).toContain("link.md");
  expect(tree.files).toContain("linkdir/a.md");

  const search = (await (await fetch(`${origin}/api/search?q=NEEDLE`)).json()) as {
    results: { path: string }[];
  };
  const paths = search.results.map((hit) => hit.path).sort();
  expect(paths).toEqual(["real.md", "realdir/a.md"]);
});

// --- resolveEntry --------------------------------------------------------------

test("resolveEntry distingue el enlace de su destino y rechaza salirse del raíz", async () => {
  const viaLink = await resolveEntry(root, "link.md");
  expect(viaLink.real).toBe(join(root, "real.md"));
  expect(viaLink.entry).toBe(join(root, "link.md"));

  const plain = await resolveEntry(root, "real.md");
  expect(plain.entry).toBe(plain.real);

  await expect(resolveEntry(root, "fuera.md")).rejects.toMatchObject({ status: 403 });
  await expect(resolveEntry(root, "roto.md")).rejects.toMatchObject({ status: 404 });
});

// --- mv / rm sobre enlaces --------------------------------------------------------

test("mover un enlace mueve el enlace, no su destino, y sigue apuntando al mismo archivo", async () => {
  await writeFile(join(root, "m-real.md"), "# Destino\n");
  await symlink("m-real.md", join(root, "m-link.md"));

  const response = await move("m-link.md", "sub/movido.md");
  expect(response.status).toBe(204);

  // El destino no se tocó.
  expect(await readFile(join(root, "m-real.md"), "utf8")).toBe("# Destino\n");
  expect((await lstat(join(root, "m-real.md"))).isSymbolicLink()).toBe(false);
  // El enlace antiguo ya no está y el nuevo resuelve (aunque ahora esté en otra carpeta).
  await expect(lstat(join(root, "m-link.md"))).rejects.toThrow();
  expect((await lstat(join(root, "sub", "movido.md"))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(root, "sub", "movido.md"))).toBe("../m-real.md");
  expect(await readFile(join(root, "sub", "movido.md"), "utf8")).toBe("# Destino\n");
});

test("borrar un enlace borra el enlace y deja su destino", async () => {
  await writeFile(join(root, "d-real.md"), "# Sigue aquí\n");
  await symlink("d-real.md", join(root, "d-link.md"));

  const response = await fetch(file("d-link.md"), { method: "DELETE" });
  expect(response.status).toBe(204);
  await expect(lstat(join(root, "d-link.md"))).rejects.toThrow();
  expect(await readFile(join(root, "d-real.md"), "utf8")).toBe("# Sigue aquí\n");
});

test("borrar con If-Match comprueba el contenido del destino", async () => {
  await writeFile(join(root, "c-real.md"), "# Contenido\n");
  await symlink("c-real.md", join(root, "c-link.md"));

  const stale = await fetch(file("c-link.md"), { method: "DELETE", headers: { "If-Match": '"x"' } });
  expect(stale.status).toBe(409);
  await expect(lstat(join(root, "c-link.md"))).resolves.toBeTruthy();

  const etag = (await fetch(file("c-link.md"))).headers.get("etag")!;
  const ok = await fetch(file("c-link.md"), { method: "DELETE", headers: { "If-Match": etag } });
  expect(ok.status).toBe(204);
});

test("renombrar por una carpeta enlazada actúa sobre el archivo de esa carpeta (como mv)", async () => {
  await writeFile(join(root, "realdir", "p.md"), "# Por la carpeta\n");
  const response = await move("linkdir/p.md", "p-movido.md");
  expect(response.status).toBe(204);
  expect(await readFile(join(root, "p-movido.md"), "utf8")).toBe("# Por la carpeta\n");
  await expect(stat(join(root, "realdir", "p.md"))).rejects.toThrow();
});

test("mover o borrar enlaces que salen del raíz se rechaza sin tocar nada", async () => {
  expect((await move("fuera.md", "x.md")).status).toBe(403);
  expect((await fetch(file("fuera.md"), { method: "DELETE" })).status).toBe(403);
  expect(await readFile(join(base, "fuera.md"), "utf8")).toBe("# Fuera NEEDLE\n");
  expect((await lstat(join(root, "fuera.md"))).isSymbolicLink()).toBe(true);
});

// --- Watcher -----------------------------------------------------------------------

test("un cambio en el archivo real también avisa por la ruta del enlace", async () => {
  await writeFile(join(root, "w-real.md"), "uno\n");
  await symlink("w-real.md", join(root, "w-link.md"));

  const events: DiskEvent[] = [];
  const local = createFileWatcher(root);
  local.subscribe((event) => events.push(event));
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(join(root, "w-real.md"), "dos\n");
    await waitFor(
      () =>
        events.some((event) => event.path === "w-real.md") &&
        events.some((event) => event.path === "w-link.md"),
    );
  } finally {
    local.close();
  }
});

test("un enlace creado con el watcher en marcha también recibe avisos", async () => {
  await mkdir(join(root, "wdir"));
  await writeFile(join(root, "wdir", "x.md"), "uno\n");

  const events: DiskEvent[] = [];
  const local = createFileWatcher(root);
  local.subscribe((event) => events.push(event));
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await symlink("wdir", join(root, "wlink"));
    await waitFor(() => events.some((event) => event.path === "wlink/x.md"));

    events.length = 0;
    await writeFile(join(root, "wdir", "x.md"), "dos\n");
    await waitFor(
      () =>
        events.some((event) => event.path === "wdir/x.md") &&
        events.some((event) => event.path === "wlink/x.md"),
    );
  } finally {
    local.close();
  }
});
