import { HttpError, isMarkdown, listMarkdown, resolveFile } from "./files.ts";

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

export function createRoutes(root: string, port: number) {
  const suffix = port === 80 ? "" : `:${port}`;
  const hosts = new Set([`127.0.0.1${suffix}`, `localhost${suffix}`]);

  // Comprobar Host evita ataques de DNS rebinding desde otras webs.
  const guard = (handler: Handler): Handler => async (req) => {
    try {
      if (!hosts.has(req.headers.get("host") ?? "")) {
        throw new HttpError(403, "Host no permitido.");
      }
      return await handler(req);
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
      }
      console.error(error);
      return Response.json({ error: "Error interno." }, { status: 500, headers: NO_STORE });
    }
  };

  async function markdownFile(req: Request) {
    const file = await resolveFile(root, new URL(req.url).searchParams.get("path"));
    if (!isMarkdown(file)) throw new HttpError(400, "Solo se admiten archivos .md.");
    return file;
  }

  function rawPath(req: Request) {
    try {
      return decodeURIComponent(new URL(req.url).pathname.slice(FILES_PREFIX.length));
    } catch {
      throw new HttpError(400, "Falta la ruta o no es válida.");
    }
  }

  return {
    "/api/tree": {
      GET: guard(async () => Response.json({ files: await listMarkdown(root) }, { headers: NO_STORE })),
    },
    "/api/file": {
      GET: guard(async (req) => {
        const file = await markdownFile(req);
        return new Response(Bun.file(file), {
          headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
        });
      }),
      PUT: guard(async (req) => {
        const file = await markdownFile(req);
        await Bun.write(file, await req.text());
        return new Response(null, { status: 204 });
      }),
    },
    [`${FILES_PREFIX}*`]: {
      GET: guard(async (req) => {
        const file = await resolveFile(root, rawPath(req));
        return new Response(Bun.file(file), { headers: RAW_HEADERS });
      }),
    },
  };
}
