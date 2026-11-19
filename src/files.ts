import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMarkdownPath } from "./paths.ts";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const isIgnored = (name: string) => name.startsWith(".") || name === "node_modules";

export const isMarkdown = isMarkdownPath;

/** Un Markdown visible del raíz. */
export interface MarkdownEntry {
  /** Ruta tal como se ve desde el raíz (puede pasar por enlaces simbólicos). */
  path: string;
  /** Ruta real, relativa al raíz, cuando `path` llega a través de un enlace simbólico. */
  real?: string;
}

// Enlaces simbólicos encadenados que se siguen como máximo: con enlaces cruzados
// entre carpetas el número de rutas crece muy deprisa.
const MAX_LINK_HOPS = 8;

/**
 * Markdown visibles, con la ruta real de los que pasan por un enlace simbólico.
 *
 * La política es la misma que la de `resolveFile`: un enlace cuyo destino real está
 * dentro del raíz (y no es oculto) se trata como el archivo o carpeta a la que
 * apunta; uno que sale del raíz, está roto o crea un bucle no aparece. Así todo lo
 * que la API sirve también se lista, se busca y se enlaza con `[[wiki]]`.
 */
export async function listMarkdownEntries(root: string): Promise<MarkdownEntry[]> {
  const realRoot = await realpath(root).catch(() => root);

  type Kind = "file" | "dir" | null;
  interface Item {
    name: string;
    kind: Kind;
    /** Ruta real absoluta. */
    real: string;
    link: boolean;
  }

  // Mismo orden que antes (archivos de la carpeta y luego subcarpetas por nombre),
  // pero las subcarpetas se leen en paralelo en vez de una tras otra.
  async function walk(
    realDir: string,
    prefix: string,
    chain: readonly string[],
    hops: number,
  ): Promise<MarkdownEntry[]> {
    const entries = await readdir(realDir, { withFileTypes: true }).catch(() => []);
    const visible = entries
      .filter((entry) => !isIgnored(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const items = await Promise.all(
      visible.map(async (entry): Promise<Item | null> => {
        const abs = join(realDir, entry.name);
        if (!entry.isSymbolicLink()) {
          const kind: Kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
          return { name: entry.name, kind, real: abs, link: false };
        }

        if (hops >= MAX_LINK_HOPS) return null;
        const real = await realpath(abs).catch(() => null); // roto: no existe
        if (!real) return null;
        const inside = segmentsInside(realRoot, real); // null: sale del raíz o es el propio raíz
        if (!inside || inside.some(isIgnored)) return null;
        const info = await stat(real).catch(() => null);
        const kind: Kind = info?.isDirectory() ? "dir" : info?.isFile() ? "file" : null;
        return { name: entry.name, kind, real, link: true };
      }),
    );

    const aliased = hops > 0;
    const files = items
      // La API solo sirve Markdown y comprueba la extensión del destino real: un
      // enlace `nota.md` hacia un `.txt` no se lista porque no se podría abrir.
      .filter(
        (item): item is Item =>
          item !== null &&
          item.kind === "file" &&
          isMarkdown(item.name) &&
          (!item.link || isMarkdown(item.real)),
      )
      .map((item): MarkdownEntry => {
        const path = prefix + item.name;
        if (!aliased && !item.link) return { path };
        const real = relative(realRoot, item.real).split(sep).join("/");
        return real === path ? { path } : { path, real };
      });

    const nested = await Promise.all(
      items
        .filter((item): item is Item => item !== null && item.kind === "dir")
        // Un enlace a una carpeta que ya se está recorriendo sería un bucle.
        .filter((item) => !chain.includes(item.real))
        .map((item) =>
          walk(item.real, `${prefix}${item.name}/`, [...chain, item.real], hops + (item.link ? 1 : 0)),
        ),
    );
    return files.concat(...nested);
  }

  return walk(realRoot, "", [realRoot], 0);
}

export async function listMarkdown(root: string): Promise<string[]> {
  return (await listMarkdownEntries(root)).map((entry) => entry.path);
}

/**
 * Rutas que conviene recorrer para buscar texto: un archivo alcanzable por varias
 * rutas (un enlace y su destino) se lee una sola vez, con preferencia por la ruta
 * directa, para que el buscador no devuelva cada coincidencia duplicada.
 */
export function uniquePaths(entries: readonly MarkdownEntry[]): string[] {
  const direct = new Set(entries.filter((entry) => !entry.real).map((entry) => entry.path));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { path, real } of entries) {
    if (real) {
      if (direct.has(real) || seen.has(real)) continue;
      seen.add(real);
    }
    result.push(path);
  }
  return result;
}

function segmentsInside(root: string, target: string): string[] | null {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep);
}

// `root` debe ser una ruta real (sin enlaces simbólicos). Se comprueba la ruta
// pedida y también la real, para que un enlace simbólico no pueda salir del raíz.
export async function resolveFile(root: string, path: string | null): Promise<string> {
  if (!path || path.includes("\0")) throw new HttpError(400, "Missing or invalid path.");

  const check = (target: string) => {
    const segments = segmentsInside(root, target);
    if (!segments) throw new HttpError(403, "Path outside the root directory.");
    if (segments.some(isIgnored)) throw new HttpError(404, "File not found.");
  };

  const target = resolve(root, path);
  check(target);

  const real = await realpath(target).catch(() => null);
  if (!real) throw new HttpError(404, "File not found.");
  check(real);

  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "File not found.");
  return real;
}

/**
 * Como `resolveFile`, pero devuelve además `entry`: la ruta del propio archivo, no
 * la de su destino. Para renombrar o borrar un enlace simbólico hay que actuar sobre
 * el enlace (como hacen `mv` y `rm`); con la ruta real se movería o borraría el
 * archivo al que apunta y el enlace quedaría roto. La carpeta que contiene a `entry`
 * se resuelve y se comprueba, de modo que pasar por una carpeta enlazada tampoco
 * permite salir del raíz.
 */
export async function resolveEntry(
  root: string,
  path: string | null,
): Promise<{ real: string; entry: string }> {
  const real = await resolveFile(root, path);
  const target = resolve(root, path!);

  const parent = await realpath(dirname(target)).catch(() => null);
  if (!parent) throw new HttpError(404, "File not found.");
  if (parent !== root) {
    const segments = segmentsInside(root, parent);
    if (!segments) throw new HttpError(403, "Path outside the root directory.");
    if (segments.some(isIgnored)) throw new HttpError(404, "File not found.");
  }
  return { real, entry: join(parent, basename(target)) };
}

// Como `resolveFile`, pero permite que el archivo aún no exista: se usa al
// recrear un archivo borrado. La carpeta sí debe existir y estar dentro del
// raíz; si el archivo existe se sigue su ruta real para no escapar por symlinks.
export async function resolveWritable(root: string, path: string | null): Promise<string> {
  if (!path || path.includes("\0")) throw new HttpError(400, "Missing or invalid path.");

  const check = (target: string) => {
    const segments = segmentsInside(root, target);
    if (!segments) throw new HttpError(403, "Path outside the root directory.");
    if (segments.some(isIgnored)) throw new HttpError(404, "File not found.");
  };

  const target = resolve(root, path);
  check(target);

  const parent = await realpath(dirname(target)).catch(() => null);
  if (!parent) throw new HttpError(404, "The file's folder does not exist.");
  if (parent !== root) {
    const parentSegments = segmentsInside(root, parent);
    if (!parentSegments) throw new HttpError(403, "Path outside the root directory.");
    if (parentSegments.some(isIgnored)) throw new HttpError(404, "File not found.");
  }

  const real = await realpath(target).catch(() => null);
  if (real) {
    check(real);
    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "File not found.");
    return real;
  }

  // Si existe pero `realpath` falla es un symlink roto: escribir en él podría
  // crear el destino fuera del raíz.
  if (await lstat(target).catch(() => null)) {
    throw new HttpError(403, "Path outside the root directory.");
  }

  return join(parent, basename(target));
}

// Para crear o mover un archivo: la ruta destino no debe existir y debe quedar
// dentro del raíz. Las carpetas intermedias pueden no existir todavía (las crea
// el llamador). El ancestro existente más profundo se resuelve con `realpath`
// para que un enlace simbólico no pueda sacar el archivo del raíz; las carpetas
// que aún no existen no pueden ser enlaces.
export async function resolveNew(root: string, path: string | null): Promise<string> {
  if (!path || path.includes("\0")) throw new HttpError(400, "Missing or invalid path.");

  const target = resolve(root, path);
  const segments = segmentsInside(root, target);
  if (!segments) throw new HttpError(403, "Path outside the root directory.");
  if (segments.some(isIgnored)) {
    throw new HttpError(400, "Hidden files and folders are not allowed.");
  }

  let ancestor = dirname(target);
  for (;;) {
    const real = await realpath(ancestor).catch(() => null);
    if (real) {
      if (real !== root) {
        const inside = segmentsInside(root, real);
        if (!inside || inside.some(isIgnored)) {
          throw new HttpError(403, "Path outside the root directory.");
        }
      }
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new HttpError(404, "The file's folder does not exist.");
    ancestor = parent;
  }

  // `lstat` también detecta un symlink roto en esa ruta.
  if (await lstat(target).catch(() => null)) {
    throw new HttpError(409, "A file already exists at that path.");
  }
  return target;
}
