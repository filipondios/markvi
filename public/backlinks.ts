// Backlinks del documento actual (`space + b`): las líneas de otros archivos que
// lo enlazan con `[[wiki]]` o con un enlace Markdown. El servidor hace el
// escaneo; el preview muestra el archivo de origen con el bloque resaltado.

import { markHit, type GrepHit } from "./grep.ts";
import { renderMarkdown } from "./render.ts";
import { createSelector, highlight, type Selector } from "./selector.ts";

export interface BacklinksOptions {
  /** Archivo del que se piden los backlinks (la pestaña activa). */
  path: () => string | undefined;
  load: (path: string) => Promise<{ results: GrepHit[]; truncated: boolean }>;
  read: (path: string) => Promise<string>;
  /** Abre el archivo de origen y salta a la línea. */
  open: (path: string, line: number) => void;
}

export type Backlinks = Selector;

export function createBacklinks(options: BacklinksOptions): Backlinks {
  let truncated = false;

  return createSelector<GrepHit>({
    title: "Backlinks",
    placeholder: "Filter backlinks…",
    listLabel: "Backlinks",
    hint: "↑↓ or Ctrl+j/k move · Enter open · Esc close",
    wide: true,
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
      const hit = item.data;
      const loc = `${hit.path}:${hit.line}`;
      const offset = loc.length + 1;

      // Sin filtro se resalta el propio enlace; con filtro, lo que coincide.
      const marked = positions.length
        ? positions
        : hit.matches.flatMap(([from, to]) =>
            Array.from({ length: to - from }, (_, index) => from + index + offset),
          );

      const locNode = document.createElement("span");
      locNode.className = "grep-loc";
      locNode.append(highlight(loc, marked.filter((position) => position < loc.length)));

      const textNode = document.createElement("span");
      textNode.className = "grep-text";
      textNode.append(
        highlight(
          hit.text,
          marked.filter((position) => position >= offset).map((position) => position - offset),
        ),
      );

      const row = document.createElement("span");
      row.className = "grep-row";
      row.append(locNode, textNode);
      return row;
    },
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
    count: (shown, total) => (total > 0 ? `${shown}/${total}${truncated ? "+" : ""}` : ""),
  });
}
