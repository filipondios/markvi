// Búsqueda de texto en todos los archivos (`space + /`): el servidor hace el
// grep y el preview muestra el archivo renderizado con el bloque resaltado.

import type { SearchHit, SearchResults } from "./shared/hits.ts";
import { hitRow, hitSelectorOptions } from "./hitselector.ts";
import { createSelector, type Selector, type SelectorMatch } from "./selector.ts";

export interface GrepOptions {
  search: (
    query: string,
    signal: AbortSignal,
  ) => Promise<SearchResults>;
  read: (path: string) => Promise<string>;
  /** Abre el archivo y salta a la línea. */
  open: (path: string, line: number) => void;
}

export type Grep = Selector;

export function createGrep(options: GrepOptions): Grep {
  let truncated = false;

  return createSelector(
    hitSelectorOptions(
      {
        title: "Search text",
        placeholder: "Search text…",
        listLabel: "Matches",
        hint: "↑↓ or Ctrl+j/k move · Enter open · Esc close",
        empty: (query) => (query.trim() ? "No matches." : "Type to search all files."),
        items: () => [],
        async query(query, signal) {
          const { results, truncated: more } = await options.search(query, signal);
          truncated = more;
          return results.map<SelectorMatch<SearchHit>>((hit) => {
            const positions: number[] = [];
            for (const [from, to] of hit.matches) {
              for (let index = from; index < to; index++) positions.push(index);
            }
            return { item: { key: `${hit.path}:${hit.line}`, label: hit.text, data: hit }, positions };
          });
        },
        renderItem(item, positions) {
          return hitRow(`${item.data.path}:${item.data.line}`, item.data.text, [], positions);
        },
      },
      {
        read: options.read,
        open: options.open,
        count: (shown, _total, more) => (shown > 0 ? `${shown}${more ? "+" : ""}` : ""),
      },
      () => truncated,
    ),
  );
}
