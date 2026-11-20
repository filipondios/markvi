// Enlaces `[[wiki]]`: sintaxis y resolución de nombres. No importa nada de Node,
// Bun ni del DOM: lo comparten el render del cliente y los backlinks del servidor.
//
// Sintaxis admitida:
//   [[Nota]]              archivo por nombre (sin `.md`, sin distinguir mayúsculas)
//   [[carpeta/Nota]]      sufijo de ruta, para desambiguar nombres repetidos
//   [[Nota#Título]]       sección del archivo
//   [[#Título]]           sección del propio documento
//   [[Nota|texto]]        texto visible distinto

export interface WikiRef {
  /** Nombre del archivo; vacío en `[[#Título]]` (el propio documento). */
  target: string;
  /** Título de sección sin `#`; vacío si no hay. */
  heading: string;
  /** Texto visible alternativo; vacío si no hay. */
  alias: string;
}

const WIKI_SOURCE = String.raw`\[\[([^\[\]\n|#]*)(?:#([^\[\]\n|]*))?(?:\|([^\[\]\n]*))?\]\]`;

/** Un enlace al inicio del texto (para el tokenizador inline de marked). */
export const wikiStartRegExp = () => new RegExp(`^${WIKI_SOURCE}`);

/** Todos los enlaces de un texto. */
export const wikiGlobalRegExp = () => new RegExp(WIKI_SOURCE, "g");

/** Convierte una coincidencia de las expresiones anteriores; `null` si no es un enlace. */
export function matchWikiLink(match: RegExpMatchArray): WikiRef | null {
  const ref = {
    target: (match[1] ?? "").trim(),
    heading: (match[2] ?? "").trim(),
    alias: (match[3] ?? "").trim(),
  };
  return ref.target || ref.heading ? ref : null;
}

/** Texto visible del enlace: el alias o, si no, `Nota > Título`. */
export function wikiLabel(ref: WikiRef): string {
  if (ref.alias) return ref.alias;
  if (ref.target && ref.heading) return `${ref.target} > ${ref.heading}`;
  return ref.target || ref.heading;
}

/** Identificador de un título (el mismo que el render pone en su `id`). */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * Une `base` (carpeta con `/` final o vacía) y una ruta relativa, resolviendo
 * `.` y `..`. `null` si sale del directorio raíz.
 */
export function joinRelative(base: string, relative: string): string | null {
  const stack: string[] = [];
  for (const segment of `${base}${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.pop() === undefined) return null;
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

const stripMd = (path: string) => path.replace(/\.md$/i, "");

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);

interface Entry {
  file: string;
  /** Ruta en minúsculas y sin `.md`. */
  key: string;
  depth: number;
}

export interface WikiIndex {
  /** Archivo al que apunta `target` desde `from`, o `null` si no existe. */
  resolve(target: string, from: string): string | null;
}

/**
 * Índice para resolver nombres. Obsidian-style: se busca por nombre de archivo
 * o por sufijo de ruta; si hay varios gana el de la misma carpeta que el origen,
 * luego la ruta exacta desde la raíz, luego el menos profundo y por último el
 * orden alfabético. Una ruta que empieza por `/`, `./` o `../` es exacta.
 */
export function createWikiIndex(files: readonly string[]): WikiIndex {
  const byName = new Map<string, Entry[]>();
  for (const file of files) {
    const key = stripMd(file).toLowerCase();
    const entry = { file, key, depth: file.split("/").length };
    const name = lastSegment(key);
    const list = byName.get(name);
    if (list) list.push(entry);
    else byName.set(name, [entry]);
  }

  return {
    resolve(target, from) {
      let raw = target.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
      if (!raw) return from;

      const fromDir = directoryOf(from);
      let exactOnly = false;
      if (raw.startsWith("/")) {
        raw = raw.replace(/^\/+/, "");
        exactOnly = true;
      } else if (raw.startsWith("./") || raw.startsWith("../")) {
        const joined = joinRelative(fromDir, raw);
        if (joined === null) return null;
        raw = joined;
        exactOnly = true;
      }

      const name = stripMd(raw).toLowerCase();
      if (!name) return null;

      const candidates = byName.get(lastSegment(name));
      if (!candidates) return null;

      const sibling = `${fromDir}${name}`.toLowerCase();
      let best: Entry | undefined;
      let bestRank: [number, number, number] = [3, 3, Infinity];

      for (const entry of candidates) {
        const exact = entry.key === name;
        if (!exact && (exactOnly || !entry.key.endsWith(`/${name}`))) continue;

        const rank: [number, number, number] = [
          !exactOnly && entry.key === sibling ? 0 : 1,
          exact ? 0 : 1,
          entry.depth,
        ];
        const better =
          rank[0] - bestRank[0] ||
          rank[1] - bestRank[1] ||
          rank[2] - bestRank[2] ||
          (best ? entry.file.localeCompare(best.file) : -1);
        if (better < 0) {
          best = entry;
          bestRank = rank;
        }
      }

      return best?.file ?? null;
    },
  };
}
