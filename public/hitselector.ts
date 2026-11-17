// Cableado compartido por los selectores de grep y backlinks: fila, preview y
// resaltado del bloque. Cada feature solo aporta cómo carga y cómo puntúa.

import type { SearchHit } from "../src/hits.ts";
import { renderMarkdown } from "./render.ts";
import { highlight, type SelectorOptions } from "./selector.ts";

/** Fila `grep-loc` / `grep-text`: la misma estructura para ambos selectores. */
export function hitRow(
  loc: string,
  text: string,
  locPositions: readonly number[],
  textPositions: readonly number[],
): HTMLElement {
  const row = document.createElement("span");
  row.className = "grep-row";

  const locNode = document.createElement("span");
  locNode.className = "grep-loc";
  locNode.append(highlight(loc, locPositions));

  const textNode = document.createElement("span");
  textNode.className = "grep-text";
  textNode.append(highlight(text, textPositions));

  row.append(locNode, textNode);
  return row;
}

/** Resalta el bloque más profundo que contiene la línea y lo centra en el preview. */
export function markHit(body: HTMLElement, line: number) {
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

export interface HitSelectorDeps {
  read: (path: string) => Promise<string>;
  open: (path: string, line: number) => void;
  count: (shown: number, total: number, truncated: boolean) => string;
}

type HitOptions = Pick<
  SelectorOptions<SearchHit>,
  "title" | "placeholder" | "listLabel" | "hint" | "empty" | "items" | "renderItem"
> &
  Partial<Pick<SelectorOptions<SearchHit>, "query" | "wide">>;

/** Rellena las opciones que grep y backlinks comparten sin excepción. */
export function hitSelectorOptions(
  options: HitOptions,
  deps: HitSelectorDeps,
  isTruncated: () => boolean,
): SelectorOptions<SearchHit> {
  return {
    wide: true,
    ...options,
    previewKey: (item) => item.data.path,
    preview: (item) =>
      deps.read(item.data.path).then((source) => renderMarkdown(source, item.data.path)),
    previewTitle: (item) => `${item.data.path}:${item.data.line}`,
    afterPreview: (item, body) => markHit(body, item.data.line),
    choose: (item) => deps.open(item.data.path, item.data.line),
    count: (shown, total) => deps.count(shown, total, isTruncated()),
  };
}
