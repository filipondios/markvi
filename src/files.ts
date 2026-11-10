import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isIgnored = (name: string) => name.startsWith(".") || name === "node_modules";

export const isMarkdown = (path: string) => path.toLowerCase().endsWith(".md");

export async function listMarkdown(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const visible = entries
      .filter((entry) => !isIgnored(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of visible) {
      if (entry.isFile() && isMarkdown(entry.name)) files.push(prefix + entry.name);
    }
    for (const entry of visible) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
  }

  await walk(root, "");
  return files;
}

function segmentsInside(root: string, target: string): string[] | null {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep);
}

// `root` debe ser una ruta real (sin enlaces simbólicos). Se comprueba la ruta
// pedida y también la real, para que un enlace simbólico no pueda salir del raíz.
export async function resolveFile(root: string, path: string | null): Promise<string> {
  if (!path || path.includes("\0")) throw new HttpError(400, "Falta la ruta o no es válida.");

  const check = (target: string) => {
    const segments = segmentsInside(root, target);
    if (!segments) throw new HttpError(403, "Ruta fuera del directorio raíz.");
    if (segments.some(isIgnored)) throw new HttpError(404, "Archivo no encontrado.");
  };

  const target = resolve(root, path);
  check(target);

  const real = await realpath(target).catch(() => null);
  if (!real) throw new HttpError(404, "Archivo no encontrado.");
  check(real);

  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "Archivo no encontrado.");
  return real;
}
