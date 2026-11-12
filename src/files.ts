import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const isIgnored = (name: string) => name.startsWith(".") || name === "node_modules";

export const isMarkdown = (path: string) => path.toLowerCase().endsWith(".md");

export async function listMarkdown(root: string): Promise<string[]> {
  // Mismo orden que antes (archivos de la carpeta y luego subcarpetas por nombre),
  // pero las subcarpetas se leen en paralelo en vez de una tras otra.
  async function walk(dir: string, prefix: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const visible = entries
      .filter((entry) => !isIgnored(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const files = visible
      .filter((entry) => entry.isFile() && isMarkdown(entry.name))
      .map((entry) => prefix + entry.name);
    const nested = await Promise.all(
      visible
        .filter((entry) => entry.isDirectory())
        .map((entry) => walk(join(dir, entry.name), `${prefix}${entry.name}/`)),
    );
    return files.concat(...nested);
  }

  return walk(root, "");
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

// Como `resolveFile`, pero permite que el archivo aún no exista: se usa al
// recrear un archivo borrado. La carpeta sí debe existir y estar dentro del
// raíz; si el archivo existe se sigue su ruta real para no escapar por symlinks.
export async function resolveWritable(root: string, path: string | null): Promise<string> {
  if (!path || path.includes("\0")) throw new HttpError(400, "Falta la ruta o no es válida.");

  const check = (target: string) => {
    const segments = segmentsInside(root, target);
    if (!segments) throw new HttpError(403, "Ruta fuera del directorio raíz.");
    if (segments.some(isIgnored)) throw new HttpError(404, "Archivo no encontrado.");
  };

  const target = resolve(root, path);
  check(target);

  const parent = await realpath(dirname(target)).catch(() => null);
  if (!parent) throw new HttpError(404, "La carpeta del archivo no existe.");
  if (parent !== root) {
    const parentSegments = segmentsInside(root, parent);
    if (!parentSegments) throw new HttpError(403, "Ruta fuera del directorio raíz.");
    if (parentSegments.some(isIgnored)) throw new HttpError(404, "Archivo no encontrado.");
  }

  const real = await realpath(target).catch(() => null);
  if (real) {
    check(real);
    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "Archivo no encontrado.");
    return real;
  }

  // Si existe pero `realpath` falla es un symlink roto: escribir en él podría
  // crear el destino fuera del raíz.
  if (await lstat(target).catch(() => null)) {
    throw new HttpError(403, "Ruta fuera del directorio raíz.");
  }

  return join(parent, basename(target));
}
