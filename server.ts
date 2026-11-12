import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import index from "./public/index.html";
import { createRoutes } from "./src/api.ts";
import { loadConfig, resolveConfigPath } from "./src/config.ts";
import { createFileWatcher } from "./src/watch.ts";

const command =
  Bun.argv[1] && !Bun.argv[1].endsWith(".ts") ? basename(Bun.argv[1]) : "bun run server.ts";
const USAGE = `Usage: ${command} <directory> [--port <port>] [--config <file>]`;
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
      options: {
        port: { type: "string", short: "p" },
        config: { type: "string", short: "c" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function resolveRoot(positionals: string[]) {
  const [dir, ...rest] = positionals;
  if (!dir) fail("missing path of the directory to browse.");
  if (rest.length > 0) fail("only one directory is supported.");

  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info) fail(`path does not exist: ${root}`);
  if (!info.isDirectory()) fail(`path is not a directory: ${root}`);
  return realpath(root);
}

function resolvePort(value: string | undefined) {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`invalid port: ${value}`);
  }
  return port;
}

const { values, positionals } = readArgs();
const root = await resolveRoot(positionals);
const port = resolvePort(values.port);
const configPath = resolveConfigPath(values.config);
const watcher = createFileWatcher(root);

function startServer() {
  try {
    return Bun.serve({
      hostname: HOSTNAME,
      port,
      // El flujo SSE queda abierto: debe durar más que el latido (25 s).
      idleTimeout: 60,
      // Sin `development` Bun sirve el bundle sin minificar, con sourcemaps y un socket
      // HMR (y su overlay de «Runtime error»). Por defecto, bundle de producción.
      // `MARKVI_DEV=1 bun run start` recupera el modo desarrollo.
      development: Bun.env.MARKVI_DEV === "1",
      routes: {
        "/": index,
        "/view/*": index,
        ...createRoutes(root, port, watcher, configPath),
      },
      fetch() {
        return new Response("Not found", { status: 404 });
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      fail(`port ${port} is already in use. Try --port.`);
    }
    throw error;
  }
}

const server = startServer();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    watcher.close();
    server.stop(true);
    process.exit(0);
  });
}

console.log(`markvi serving ${root}`);
console.log(`${server.url}`);

const loaded = await loadConfig(configPath);
console.log(
  loaded.exists
    ? `config: ${configPath}`
    : `config: ${configPath} (not found, using defaults)`,
);
for (const warning of loaded.warnings) console.warn(`  warning: ${warning}`);
