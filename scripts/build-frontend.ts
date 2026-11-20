/**
 * Build independiente del frontend con Bun.
 *
 * Compila frontend/index.html y sus módulos en frontend/dist de forma
 * independiente: no arranca servidores ni lee example/. La salida usa rutas
 * absolutas para que el servidor Rust pueda
 * servirla tanto en / como en /view/*.
 *
 * Uso: bun run frontend:build
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "frontend", "index.html");
const OUT = join(ROOT, "frontend", "dist");
const ETAGS = join(ROOT, "frontend", "asset-etags.json");

function fail(message: string): never {
  console.error(`build-frontend: ${message}`);
  process.exit(1);
}

/** Rutas locales referenciadas en un texto (HTML o bundle JS). */
function localRefs(text: string): string[] {
  const refs: string[] = [];
  const patterns = [/(?:src|href)="(\/[^"]+)"/g, /"(\/[A-Za-z0-9._~%-]+\.[A-Za-z0-9]+)"/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const ref = match[1]!.split(/[?#]/, 1)[0]!;
      // "/" es la ruta de la app, no un archivo del bundle.
      if (ref !== "/" && !refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUT,
    publicPath: "/",
    minify: true,
    target: "browser",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    fail("Bun.build falló");
  }

  const htmlPath = join(OUT, "index.html");
  if (!(await exists(htmlPath))) fail("no se generó index.html");
  const html = await readFile(htmlPath, "utf8");

  // Las rutas de la salida deben ser absolutas: el HTML se sirve también en
  // /view/*.md, donde una ruta relativa resolvería contra /view/.
  const relative = [...html.matchAll(/(?:src|href)="(\.\.?\/[^"]+)"/g)].map((m) => m[1]);
  if (relative.length > 0) {
    fail(`index.html contiene rutas relativas que romperían /view/*: ${relative.join(", ")}`);
  }

  // Todo recurso referenciado por el HTML o por el bundle debe existir en la
  // salida (incluye el logo referenciado solo desde JS).
  const files = await readdir(OUT);
  const refs = localRefs(html);
  for (const file of files.filter((name) => /\.(js|css)$/.test(name))) {
    refs.push(...localRefs(await readFile(join(OUT, file), "utf8")));
  }
  const missing: string[] = [];
  for (const ref of refs) {
    if (!(await exists(join(OUT, ref.slice(1))))) missing.push(ref);
  }
  if (missing.length > 0) fail(`recursos referenciados ausentes en la salida: ${missing.join(", ")}`);

  // Rust necesita el tipo MIME, la caché y el ETag para cada archivo. Los ETags
  // se conservan medidos (no son derivables del contenido con Bun.hash): están
  // indexados por SHA-256 del archivo para sobrevivir a cambios de nombre hash.
  const knownEtags: Record<string, string> = JSON.parse(await readFile(ETAGS, "utf8"));
  const contentTypes: Record<string, string> = {
    ".html": "text/html;charset=utf-8",
    ".css": "text/css;charset=utf-8",
    ".js": "text/javascript;charset=utf-8",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  const assets: Record<string, unknown> = {};
  for (const file of files.filter((name) => name !== "index.html" && name !== "manifest.json").sort()) {
    const bytes = await readFile(join(OUT, file));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const etag = knownEtags[digest];
    if (!etag) fail(`sin ETag conocido para ${file} (SHA-256 ${digest}); actualiza frontend/asset-etags.json`);
    assets[`/${file}`] = {
      file,
      content_type: contentTypes[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      cache_control: "public, max-age=31536000, immutable",
      etag,
    };
  }
  const indexBytes = await readFile(htmlPath);
  const indexDigest = createHash("sha256").update(indexBytes).digest("hex");
  const indexEtag = knownEtags[indexDigest];
  if (!indexEtag) fail(`sin ETag conocido para index.html (SHA-256 ${indexDigest})`);
  const manifest = {
    schema: "markvi-static-manifest@1",
    index: { file: "index.html", content_type: "text/html;charset=utf-8", cache_control: "no-cache", etag: indexEtag },
    assets,
    fallback: { status: 404, body: "Not found" },
  };
  await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`frontend: ${files.length} archivos en ${OUT}`);
  for (const file of files.sort()) console.log(`  ${file}`);
  console.log(`frontend: ${refs.length} referencias locales verificadas`);
}

await main();
