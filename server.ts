import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import index from "./public/index.html";
import { createRoutes } from "./src/api.ts";

const USAGE = "Uso: bun run server.ts <directorio> [--port <puerto>]";
const HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 3000;

function fail(message: string): never {
  console.error(`Error: ${message}\n${USAGE}`);
  process.exit(1);
}

function readArgs() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: { port: { type: "string", short: "p" } },
      allowPositionals: true,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function resolveRoot(positionals: string[]) {
  const [dir, ...rest] = positionals;
  if (!dir) fail("falta la ruta del directorio a explorar.");
  if (rest.length > 0) fail("solo se admite un directorio.");

  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info) fail(`la ruta no existe: ${root}`);
  if (!info.isDirectory()) fail(`la ruta no es un directorio: ${root}`);
  return realpath(root);
}

function resolvePort(value: string | undefined) {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`puerto no válido: ${value}`);
  }
  return port;
}

const { values, positionals } = readArgs();
const root = await resolveRoot(positionals);
const port = resolvePort(values.port);

function startServer() {
  try {
    return Bun.serve({
      hostname: HOSTNAME,
      port,
      routes: {
        "/": index,
        "/view/*": index,
        ...createRoutes(root, port),
      },
      fetch() {
        return new Response("No encontrado", { status: 404 });
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      fail(`el puerto ${port} ya está en uso. Prueba con --port.`);
    }
    throw error;
  }
}

const server = startServer();

console.log(`markvi sirviendo ${root}`);
console.log(`→ ${server.url}`);
