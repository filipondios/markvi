// Búsqueda de texto en todos los archivos (`space + /`): el servidor hace el
// grep y el preview muestra el archivo renderizado con el bloque resaltado.

import { renderMarkdown } from "./render.ts";
import { createSelector, highlight, type Selector, type SelectorMatch } from "./selector.ts";

export interface GrepHit {
  path: string;
  line: number;
  text: string;
  matches: [number, number][];
}

export interface GrepOptions {
  search: (
    query: string,
    signal: AbortSignal,
  ) => Promise<{ results: GrepHit[]; truncated: boolean }>;
  read: (path: string) => Promise<string>;
  /** Abre el archivo y salta a la línea. */
  open: (path: string, line: number) => void;
}

export type Grep = Selector;

export function createGrep(options: GrepOptions): Grep {
  let truncated = false;

  return createSelector<GrepHit>({
    title: "Search text",
    placeholder: "Search text…",
    listLabel: "Matches",
    hint: "↑↓ or Ctrl+j/k move · Enter open · Esc close",
    wide: true,
    empty: (query) => (query.trim() ? "No matches." : "Type to search all files."),
    items: () => [],
    async query(query, signal) {
      const { results, truncated: more } = await options.search(query, signal);
      truncated = more;
      return results.map<SelectorMatch<GrepHit>>((hit) => {
        const positions: number[] = [];
        for (const [from, to] of hit.matches) {
          for (let index = from; index < to; index++) positions.push(index);
        }
        return {
          item: { key: `${hit.path}:${hit.line}`, label: hit.text, data: hit },
          positions,
        };
      });
    },
    renderItem(item, positions) {
      const fragment = document.createDocumentFragment();

      const loc = document.createElement("span");
      loc.className = "grep-loc";
      loc.textContent = `${item.data.path}:${item.data.line}`;

      const text = document.createElement("span");
      text.className = "grep-text";
      text.append(highlight(item.data.text, positions));

      const row = document.createElement("span");
      row.className = "grep-row";
      row.append(loc, text);
      fragment.append(row);
      return fragment;
    },
    // Un archivo, un preview: las coincidencias del mismo archivo lo comparten.
    previewKey: (item) => item.data.path,
    preview(item) {
      return options.read(item.data.path).then((source) => renderMarkdown(source, item.data.path));
    },
    previewTitle: (item) => `${item.data.path}:${item.data.line}`,
    afterPreview(item, body) {
      markHit(body, item.data.line);
    },
    choose(item) {
      options.open(item.data.path, item.data.line);
    },
    count: (shown) => (shown > 0 ? `${shown}${truncated ? "+" : ""}` : ""),
  });
}

/** Resalta el bloque más profundo que contiene la línea y lo centra en el preview. */
function markHit(body: HTMLElement, line: number) {
  body.querySelectorAll(".finder-hit").forEach((node) => node.classList.remove("finder-hit"));

  let best: HTMLElement | undefined;
  let bestSpan = Infinity;
  for (const block of body.querySelectorAll<HTMLElement>("[data-line]")) {
    const start = Number(block.dataset.line);
    const end = Number(block.dataset.endLine ?? start);
    if (!(start <= line && line <= end)) continue;
    // El más corto es el más profundo (un li dentro de un ul, etc.).
    if (end - start <= bestSpan) {
      best = block;
      bestSpan = end - start;
    }
  }
  if (!best) return;
  best.classList.add("finder-hit");
  best.scrollIntoView({ block: "center" });
}
