// Backlinks del documento actual (`space + b`): las líneas de otros archivos que
// lo enlazan con `[[wiki]]` o con un enlace Markdown. El servidor hace el
// escaneo; el preview muestra el archivo de origen con el bloque resaltado.

import type { SearchHit, SearchResults } from "./shared/hits.ts";
import { hitRow, hitSelectorOptions } from "./hitselector.ts";
import { createSelector, type Selector } from "./selector.ts";

export interface BacklinksOptions {
  /** Archivo del que se piden los backlinks (la pestaña activa). */
  path: () => string | undefined;
  load: (path: string) => Promise<SearchResults>;
  read: (path: string) => Promise<string>;
  /** Abre el archivo de origen y salta a la línea. */
  open: (path: string, line: number) => void;
}

export type Backlinks = Selector;

export function createBacklinks(options: BacklinksOptions): Backlinks {
  let truncated = false;

  return createSelector(
    hitSelectorOptions(
      {
        title: "Backlinks",
        placeholder: "Filter backlinks…",
        listLabel: "Backlinks",
        hint: "↑↓ or Ctrl+j/k move · Enter open · Esc close",
        empty: (query) => (query ? "No results." : "No backlinks to this file."),
        async items() {
          const path = options.path();
          if (!path) return [];
          const found = await options.load(path);
          truncated = found.truncated;
          return found.results.map((hit) => ({
            key: `${hit.path}:${hit.line}`,
            // La ubicación forma parte del texto para poder filtrar también por archivo.
            label: `${hit.path}:${hit.line} ${hit.text}`,
            data: hit,
          }));
        },
        renderItem(item, positions) {
          const hit: SearchHit = item.data;
          const loc = `${hit.path}:${hit.line}`;
          const offset = loc.length + 1;

          // Sin filtro se resalta el propio enlace; con filtro, lo que coincide.
          const marked = positions.length
            ? positions
            : hit.matches.flatMap(([from, to]) =>
                Array.from({ length: to - from }, (_, index) => from + index + offset),
              );

          return hitRow(
            loc,
            hit.text,
            marked.filter((position) => position < loc.length),
            marked.filter((position) => position >= offset).map((position) => position - offset),
          );
        },
      },
      {
        read: options.read,
        open: options.open,
        count: (shown, total, more) => (total > 0 ? `${shown}/${total}${more ? "+" : ""}` : ""),
      },
      () => truncated,
    ),
  );
}
