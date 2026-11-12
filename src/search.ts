import { join } from "node:path";
import { listMarkdown } from "./files.ts";

export interface SearchHit {
  path: string;
  /** Línea del archivo, empezando en 1. */
  line: number;
  /** Texto de la línea, sin sangría y recortado alrededor de la coincidencia. */
  text: string;
  /** Rangos `[desde, hasta)` de las coincidencias dentro de `text`. */
  matches: [number, number][];
}

export interface SearchResults {
  results: SearchHit[];
  /** Hay más coincidencias de las que se devuelven. */
  truncated: boolean;
}

export interface SearchOptions {
  /** Máximo de coincidencias devueltas en total. */
  limit?: number;
  /** Máximo de coincidencias por archivo, para que uno solo no copie la lista. */
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

// Una línea larga se recorta para que la lista siga siendo legible.
const MAX_TEXT = 240;
const CONTEXT_BEFORE = 40;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildHit(path: string, line: number, raw: string, ranges: [number, number][]): SearchHit {
  const lead = raw.length - raw.trimStart().length;
  let start = lead;
  let end = raw.trimEnd().length;
  let cutEnd = false;

  if (end - start > MAX_TEXT) {
    start = Math.max(start, ranges[0]![0] - CONTEXT_BEFORE);
    if (end - start > MAX_TEXT) {
      end = start + MAX_TEXT;
      cutEnd = true;
    }
  }

  const prefix = start > lead ? "…" : "";
  const text = prefix + raw.slice(start, end) + (cutEnd ? "…" : "");
  const shift = prefix.length - start;
  const matches = ranges
    .filter(([from, to]) => to > start && from < end)
    .map(([from, to]): [number, number] => [Math.max(from, start) + shift, Math.min(to, end) + shift]);

  return { path, line, text, matches };
}

/**
 * Busca `query` como texto literal en un archivo. Sin mayúsculas en la consulta
 * ignora el caso; con alguna mayúscula lo respeta (como la búsqueda del documento).
 */
export function searchText(path: string, text: string, query: string, perFile: number) {
  const sensitive = query !== query.toLowerCase();
  const pattern = new RegExp(escapeRegExp(query), sensitive ? "g" : "gi");
  const hits: SearchHit[] = [];
  let truncated = false;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const found = [...line.matchAll(pattern)];
    if (found.length === 0) continue;

    if (hits.length >= perFile) {
      truncated = true;
      break;
    }
    const ranges = found.map((match): [number, number] => [
      match.index!,
      match.index! + match[0].length,
    ]);
    hits.push(buildHit(path, index + 1, line, ranges));
  }

  return { hits, truncated };
}

export async function searchMarkdown(
  root: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResults> {
  const { limit, perFile, maxFileBytes, concurrency } = { ...DEFAULTS, ...options };
  const needle = query.trim();
  if (!needle) return { results: [], truncated: false };

  const files = await listMarkdown(root);
  const results: SearchHit[] = [];
  let full = false;
  let capped = false;

  for (let from = 0; from < files.length && !full; from += concurrency) {
    const chunk = files.slice(from, from + concurrency);
    const found = await Promise.all(
      chunk.map(async (path) => {
        const file = Bun.file(join(root, path));
        try {
          if (file.size > maxFileBytes) return { hits: [], truncated: false };
          return searchText(path, await file.text(), needle, perFile);
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
