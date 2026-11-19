import { join } from "node:path";
import { isCaseSensitive } from "./case.ts";
import { listMarkdownEntries, uniquePaths } from "./files.ts";
import type { SearchHit, SearchResults } from "./hits.ts";

export type { SearchHit, SearchResults } from "./hits.ts";

export interface ScanOptions {
  /** Máximo de coincidencias devueltas en total. */
  limit?: number;
  /** Máximo de coincidencias por archivo, para que uno solo no copie la lista. */
  perFile?: number;
  /** Los archivos más grandes se omiten. */
  maxFileBytes?: number;
  /** Archivos leídos a la vez. */
  concurrency?: number;
}

export const SCAN_DEFAULTS = {
  limit: 200,
  perFile: 20,
  maxFileBytes: 2 * 1024 * 1024,
  concurrency: 16,
};

// Una línea larga se recorta para que la lista siga siendo legible.
const MAX_TEXT = 240;
const CONTEXT_BEFORE = 40;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildHit(
  path: string,
  line: number,
  raw: string,
  ranges: [number, number][],
): SearchHit {
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
  const sensitive = isCaseSensitive(query);
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

export interface ScanFileResult {
  hits: SearchHit[];
  truncated: boolean;
}

/**
 * Escanea los `.md` visibles, aplica `searchFile` a cada uno y agota los límites.
 * Compartido por el grep y los backlinks: la gestión de archivos que desaparecen,
 * el tamaño máximo y el corte de resultados viven aquí una sola vez.
 */
export async function scanMarkdown(
  root: string,
  options: ScanOptions,
  searchFile: (path: string, text: string, perFile: number) => ScanFileResult,
  files?: readonly string[],
): Promise<SearchResults> {
  const { limit, perFile, maxFileBytes, concurrency } = { ...SCAN_DEFAULTS, ...options };
  const allFiles = files ?? uniquePaths(await listMarkdownEntries(root));
  const results: SearchHit[] = [];
  let full = false;
  let capped = false;

  for (let from = 0; from < allFiles.length && !full; from += concurrency) {
    const chunk = allFiles.slice(from, from + concurrency);
    const found = await Promise.all(
      chunk.map(async (path): Promise<ScanFileResult> => {
        const file = Bun.file(join(root, path));
        try {
          if (file.size > maxFileBytes) return { hits: [], truncated: false };
          return searchFile(path, await file.text(), perFile);
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

export async function searchMarkdown(
  root: string,
  query: string,
  options: ScanOptions = {},
): Promise<SearchResults> {
  const needle = query.trim();
  if (!needle) return { results: [], truncated: false };
  return scanMarkdown(root, options, (path, text, perFile) =>
    searchText(path, text, needle, perFile),
  );
}
