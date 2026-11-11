// Búsqueda de texto en el documento renderizado. Las coincidencias se calculan
// sobre el texto de los nodos y se convierten en `Range`, de modo que el
// resaltado no modifica el DOM ni el mapa de bloques.

export interface MatchOffset {
  start: number;
  end: number;
}

export interface TextNodeSpan {
  node: Text;
  start: number;
  end: number;
  block: Element | null;
}

export interface TextMap {
  text: string;
  spans: TextNodeSpan[];
}

/** Smart case: si la consulta lleva mayúsculas, distingue mayúsculas. */
export function isCaseSensitive(query: string) {
  return /[A-ZÁÉÍÓÚÑÜ]/.test(query);
}

export function matchOffsets(
  text: string,
  query: string,
  caseSensitive: boolean,
): MatchOffset[] {
  if (!query) return [];

  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: MatchOffset[] = [];

  let index = 0;
  while (index <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    matches.push({ start: found, end: found + needle.length });
    index = found + Math.max(1, needle.length);
  }
  return matches;
}

/**
 * Texto plano del contenido y mapa a sus nodos. Se inserta un salto entre
 * bloques distintos para que una coincidencia no cruce de un párrafo a otro;
 * como el salto no pertenece a ningún nodo, `rangeFor` la descarta.
 */
export function buildTextMap(root: Node): TextMap {
  const spans: TextNodeSpan[] = [];
  let text = "";
  let lastBlock: Element | null = null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data;
    if (data.length === 0) continue;

    const block = (node as Text).parentElement?.closest("[data-line]") ?? null;
    if (lastBlock !== block) {
      if (text.length > 0) text += "\n";
      lastBlock = block;
    }

    const start = text.length;
    text += data;
    spans.push({ node: node as Text, start, end: text.length, block });
  }

  return { text, spans };
}

export function rangeFor(
  spans: readonly TextNodeSpan[],
  start: number,
  end: number,
): Range | undefined {
  const from = spans.find((span) => start >= span.start && start < span.end);
  const to = spans.find((span) => end > span.start && end <= span.end);
  if (!from || !to || from.block !== to.block) return undefined;

  const range = document.createRange();
  range.setStart(from.node, start - from.start);
  range.setEnd(to.node, end - to.start);
  return range;
}
