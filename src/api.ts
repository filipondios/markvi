import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import {
  HttpError,
  isMarkdown,
  listMarkdown,
  resolveFile,
  resolveNew,
  resolveWritable,
} from "./files.ts";
import { loadConfig, resolveConfigPath } from "./config.ts";
import { searchBacklinks } from "./backlinks.ts";
import { searchMarkdown } from "./search.ts";
import type { DiskEvent, FileWatcher } from "./watch.ts";

type Handler = (req: Request) => Response | Promise<Response>;

const NO_STORE = { "Cache-Control": "no-store" };

// Los archivos del usuario se sirven en el mismo origen que la app: `sandbox`
// impide que un HTML o SVG abierto directamente ejecute scripts contra la API.
const RAW_HEADERS = {
  ...NO_STORE,
  "Content-Security-Policy": "sandbox",
  "X-Content-Type-Options": "nosniff",
};

const FILES_PREFIX = "/files/";
const HEARTBEAT_MS = 25_000;
const MAX_QUERY = 200;

// Identifica el contenido que el cliente leyó. No es criptográfico: solo sirve
// para detectar que el archivo cambió entre la lectura y el guardado.
const etagFor = (content: string) => `"${Bun.hash(content).toString(16)}"`;

export function createRoutes(
  root: string,
  port: number,
  watcher: FileWatcher,
  configPath = resolveConfigPath(undefined),
) {
  const suffix = port === 80 ? "" : `:${port}`;
  const hosts = new Set([`127.0.0.1${suffix}`, `localhost${suffix}`]);
  const origins = new Set([`http://127.0.0.1${suffix}`, `http://localhost${suffix}`]);

  // Comprobar Host evita ataques de DNS rebinding desde otras webs.
  const guard = (handler: Handler): Handler => async (req) => {
    try {
      if (!hosts.has(req.headers.get("host") ?? "")) {
        throw new HttpError(403, "Host not allowed.");
      }
      // Las escrituras solo valen desde esta misma app: una web ajena puede
      // lanzar un POST «simple» a 127.0.0.1 sin que el navegador lo bloquee.
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.get("origin");
        if (origin && !origins.has(origin)) throw new HttpError(403, "Origin not allowed.");
      }
      return await handler(req);
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
      }

      const code = (error as NodeJS.ErrnoException).code;
      const mapped: [number, string] | null =
        code === "ENOENT" || code === "ENOTDIR"
          ? [404, "File or folder not found."]
          : code === "EACCES" || code === "EPERM" || code === "EROFS"
            ? [403, "No permission to access the file."]
            : code === "EISDIR"
              ? [400, "The path is not a file."]
              : code === "EEXIST"
                ? [409, "A file or folder already exists at that path."]
              : code === "ENOSPC"
                ? [507, "No space left on disk."]
                : null;

      if (mapped) {
        return Response.json({ error: mapped[1] }, { status: mapped[0], headers: NO_STORE });
      }

      console.error(error);
      return Response.json({ error: "Internal error." }, { status: 500, headers: NO_STORE });
    }
  };

  async function markdownFile(req: Request) {
    const file = await resolveFile(root, new URL(req.url).searchParams.get("path"));
    if (!isMarkdown(file)) throw new HttpError(400, "Only .md files are supported.");
    return file;
  }

  async function writableMarkdown(req: Request) {
    const file = await resolveWritable(root, new URL(req.url).searchParams.get("path"));
    if (!isMarkdown(file)) throw new HttpError(400, "Only .md files are supported.");
    return file;
  }

  function rawPath(req: Request) {
    try {
      return decodeURIComponent(new URL(req.url).pathname.slice(FILES_PREFIX.length));
    } catch {
      throw new HttpError(400, "Missing or invalid path.");
    }
  }

  function events(req: Request) {
    const encoder = new TextEncoder();
    let cleanup: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: DiskEvent) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            cleanup?.();
          }
        };

        const unsubscribe = watcher.subscribe(send);
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup?.();
          }
        }, HEARTBEAT_MS);

        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Ya estaba cerrado.
          }
        };

        req.signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      headers: {
        ...NO_STORE,
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return {
    "/api/tree": {
      GET: guard(async () => Response.json({ files: await listMarkdown(root) }, { headers: NO_STORE })),
    },
    "/api/file": {
      GET: guard(async (req) => {
        const file = await markdownFile(req);
        const content = await Bun.file(file).text();
        return new Response(content, {
          headers: {
            ...NO_STORE,
            "Content-Type": "text/plain; charset=utf-8",
            ETag: etagFor(content),
          },
        });
      }),
      PUT: guard(async (req) => {
        const create = new URL(req.url).searchParams.get("create") === "1";
        const file = create ? await writableMarkdown(req) : await markdownFile(req);
        const body = await req.text();

        const ifMatch = req.headers.get("if-match");
        if (ifMatch) {
          const current = await Bun.file(file)
            .text()
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (current === null) throw new HttpError(404, "File not found.");
          const etag = etagFor(current);
          if (ifMatch !== "*" && ifMatch !== etag) {
            return Response.json(
              { error: "The file changed on disk.", etag },
              { status: 409, headers: NO_STORE },
            );
          }
        }

        await Bun.write(file, body);
        return new Response(null, {
          status: 204,
          headers: { ...NO_STORE, ETag: etagFor(body) },
        });
      }),
      // Crea un archivo nuevo (y sus carpetas). Nunca sobrescribe: si existe, 409.
      POST: guard(async (req) => {
        const path = new URL(req.url).searchParams.get("path");
        if (!path || !isMarkdown(path)) throw new HttpError(400, "Only .md files are supported.");
        const file = await resolveNew(root, path);
        const body = await req.text();

        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body, { flag: "wx" });
        return new Response(null, {
          status: 201,
          headers: { ...NO_STORE, ETag: etagFor(body) },
        });
      }),
      DELETE: guard(async (req) => {
        const file = await markdownFile(req);

        const ifMatch = req.headers.get("if-match");
        if (ifMatch && ifMatch !== "*") {
          const etag = etagFor(await Bun.file(file).text());
          if (ifMatch !== etag) {
            return Response.json(
              { error: "The file changed on disk.", etag },
              { status: 409, headers: NO_STORE },
            );
          }
        }

        await unlink(file);
        return new Response(null, { status: 204, headers: NO_STORE });
      }),
    },
    // Renombra o mueve un archivo. El destino no puede existir.
    "/api/move": {
      POST: guard(async (req) => {
        const body = (await req.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
        const from = body?.from;
        const to = body?.to;
        if (typeof from !== "string" || typeof to !== "string") {
          throw new HttpError(400, "Missing or invalid path.");
        }
        if (!isMarkdown(from) || !isMarkdown(to)) {
          throw new HttpError(400, "Only .md files are supported.");
        }

        const source = await resolveFile(root, from);
        const target = await resolveNew(root, to);
        await mkdir(dirname(target), { recursive: true });
        await rename(source, target);
        return new Response(null, { status: 204, headers: NO_STORE });
      }),
    },
    // Búsqueda de texto en todos los archivos Markdown (live grep).
    // La configuración se lee en cada petición: recargar la página aplica los cambios.
    "/api/config": {
      GET: guard(async () => Response.json(await loadConfig(configPath), { headers: NO_STORE })),
    },
    "/api/search": {
      GET: guard(async (req) => {
        const query = (new URL(req.url).searchParams.get("q") ?? "").trim();
        if (query.length > MAX_QUERY) throw new HttpError(400, "The query is too long.");
        return Response.json(await searchMarkdown(root, query), { headers: NO_STORE });
      }),
    },
    // Líneas de otros archivos que enlazan a `path` (`[[wiki]]` o enlaces Markdown).
    "/api/backlinks": {
      GET: guard(async (req) => {
        await markdownFile(req);
        const path = new URL(req.url).searchParams.get("path") ?? "";
        const target = posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, "");
        return Response.json(await searchBacklinks(root, target), { headers: NO_STORE });
      }),
    },
    "/api/events": {
      GET: guard((req) => events(req)),
    },
    [`${FILES_PREFIX}*`]: {
      GET: guard(async (req) => {
        const file = await resolveFile(root, rawPath(req));
        return new Response(Bun.file(file), { headers: RAW_HEADERS });
      }),
    },
  };
}
