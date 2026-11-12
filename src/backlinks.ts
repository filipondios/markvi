// Backlinks: líneas de otros archivos que enlazan a uno dado, ya sea con
// `[[wiki]]` o con un enlace Markdown relativo a un `.md`.

import { join, posix } from "node:path";
import { listMarkdown } from "./files.ts";
import { buildHit, type SearchHit, type SearchResults } from "./search.ts";
import { createWikiIndex, matchWikiLink, wikiGlobalRegExp, type WikiIndex } from "./wiki.ts";

export interface BacklinkOptions {
  /** Máximo de líneas devueltas en total. */
  limit?: number;
  /** Máximo de líneas por archivo. */
  perFile?: number;
  /** Los archivos más grandes se omiten. */
  maxFileBytes?: number;
  /** Archivos leídos a la vez. */
  concurrency?: number;
}

const DEFAULTS = {
  limit: 200,
  perFile: 20,
  maxFileBytes: 2 * 1024 * 1024,
  concurrency: 16,
};

/** `[texto](destino "título")`; el destino puede ir entre `<>`. Las imágenes se descartan aparte. */
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]*)[^)\n]*\)/g;

const MAYBE_LINKS = /\[\[|\.md/i;

interface FoundLink {
  /** Línea del archivo, empezando en 1. */
  line: number;
  /** Texto original de la línea. */
  raw: string;
  /** Rango del enlace dentro de `raw`. */
  range: [number, number];
  kind: "wiki" | "markdown";
  /** Nombre (wiki) o destino (Markdown), tal como está escrito. */
  target: string;
}

/** Cambia por espacios el texto entre acentos graves: ahí no hay enlaces. Conserva los índices. */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => " ".repeat(span.length));
}

/**
 * Enlaces de un documento. Se saltan los bloques de código vallados y el código
 * en línea; los bloques con sangría no se distinguen de las continuaciones de
 * lista y se tratan como texto.
 */
export function extractLinks(source: string): FoundLink[] {
  const links: FoundLink[] = [];
  let fence: { char: string; length: number } | undefined;

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;

    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }

    if (!MAYBE_LINKS.test(raw)) continue;
    const text = maskInlineCode(raw);

    for (const match of text.matchAll(wikiGlobalRegExp())) {
      const ref = matchWikiLink(match);
      if (!ref) continue;
      links.push({
        line: index + 1,
        raw,
        range: [match.index!, match.index! + match[0].length],
        kind: "wiki",
        target: ref.target,
      });
    }

    for (const match of text.matchAll(MARKDOWN_LINK)) {
      if (match[0].startsWith("!")) continue;
      links.push({
        line: index + 1,
        raw,
        range: [match.index!, match.index! + match[0].length],
        kind: "markdown",
        target: match[1]!.replace(/^<|>$/g, ""),
      });
    }
  }

  return links;
}

/** Ruta del `.md` al que apunta un enlace Markdown relativo, o `null` si no es uno. */
export function markdownTarget(destination: string, from: string): string | null {
  if (!destination || destination.startsWith("#") || destination.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) return null;

  let path = destination.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // Un escape inválido se deja tal cual.
  }
  if (!/\.md$/i.test(path)) return null;

  const resolved = path.startsWith("/")
    ? posix.normalize(path.slice(1))
    : posix.normalize(posix.join(posix.dirname(from), path));
  return resolved.startsWith("..") ? null : resolved;
}

/**
 * Líneas de `source` (el archivo `from`) que enlazan a `to`. Una línea con varios
 * enlaces al mismo archivo se devuelve una vez, con todos sus rangos.
 */
export function findBacklinks(
  source: string,
  from: string,
  to: string,
  index: WikiIndex,
  perFile = DEFAULTS.perFile,
): { hits: SearchHit[]; truncated: boolean } {
  if (from === to || !MAYBE_LINKS.test(source)) return { hits: [], truncated: false };

  const byLine = new Map<number, { raw: string; ranges: [number, number][] }>();
  for (const link of extractLinks(source)) {
    const resolved =
      link.kind === "wiki" ? index.resolve(link.target, from) : markdownTarget(link.target, from);
    if (resolved !== to) continue;

    const entry = byLine.get(link.line);
    if (entry) entry.ranges.push(link.range);
    else byLine.set(link.line, { raw: link.raw, ranges: [link.range] });
  }

  const hits: SearchHit[] = [];
  let truncated = false;
  for (const [line, { raw, ranges }] of byLine) {
    if (hits.length >= perFile) {
      truncated = true;
      break;
    }
    hits.push(buildHit(from, line, raw, ranges));
  }
  return { hits, truncated };
}

/** Backlinks de `target` (ruta relativa al raíz) en todos los archivos Markdown. */
export async function searchBacklinks(
  root: string,
  target: string,
  options: BacklinkOptions = {},
): Promise<SearchResults> {
  const { limit, perFile, maxFileBytes, concurrency } = { ...DEFAULTS, ...options };

  const files = await listMarkdown(root);
  const index = createWikiIndex(files);
  const results: SearchHit[] = [];
  let full = false;
  let capped = false;

  for (let from = 0; from < files.length && !full; from += concurrency) {
    const chunk = files.slice(from, from + concurrency);
    const found = await Promise.all(
      chunk.map(async (path) => {
        if (path === target) return { hits: [], truncated: false };
        const file = Bun.file(join(root, path));
        try {
          if (file.size > maxFileBytes) return { hits: [], truncated: false };
          return findBacklinks(await file.text(), path, target, index, perFile);
        } catch {
          // Un archivo que desaparece o no se puede leer no rompe la búsqueda.
          return { hits: [], truncated: false };
        }
      }),
    );

    for (const entry of found) {
      for (const hit of entry.hits) {
        if (results.length >= limit) {
          full = true;
          break;
        }
        results.push(hit);
      }
      if (entry.truncated) capped = true;
      if (full) break;
    }
  }

  return { results, truncated: full || capped };
}
