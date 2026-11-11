// Mapa entre las líneas del Markdown y los bloques renderizados. Se separa del
// DOM para poder probar el cálculo sin navegador.

export interface SourceLineRange {
  line: number;
  endLine: number;
}

export interface BlockBox extends SourceLineRange {
  top: number;
  bottom: number;
}

export interface LineToken {
  type: string;
  raw: string;
  line?: number;
  endLine?: number;
  tokens?: LineToken[];
  items?: LineToken[];
}

/** Posición inicial de cada línea (índice 0 = línea 1). */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

export function lineAtOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function lineStartOffset(starts: readonly number[], line: number): number {
  const index = Math.min(Math.max(1, line), starts.length) - 1;
  return starts[index] ?? 0;
}

/** Añade `line` y `endLine` a los tokens de marked, en orden de documento. */
export function annotateTokenLines(tokens: readonly LineToken[], source: string): void {
  // marked normaliza los finales de línea en `raw`; se busca sobre una copia
  // normalizada para que CRLF no desplace las líneas.
  const flat = source.replace(/\r\n?/g, "\n");
  const starts = lineStarts(flat);
  let cursor = 0;

  for (const token of tokens) {
    const found = flat.indexOf(token.raw, cursor);
    const start = found >= 0 ? found : cursor;
    setRange(token, start, starts);
    cursor = start + token.raw.length;
    if (token.type === "list") annotateList(token, flat, start, starts);
  }
}

function annotateList(
  list: LineToken,
  source: string,
  start: number,
  starts: readonly number[],
): void {
  let cursor = start;
  for (const item of list.items ?? []) {
    const found = source.indexOf(item.raw, cursor);
    const itemStart = found >= 0 ? found : cursor;
    setRange(item, itemStart, starts);
    cursor = itemStart + item.raw.length;
    annotateChildren(item, source, itemStart, starts);
  }
}

function annotateChildren(
  item: LineToken,
  source: string,
  start: number,
  starts: readonly number[],
): void {
  let cursor = start;
  for (const child of item.tokens ?? []) {
    const found = source.indexOf(child.raw, cursor);
    const childStart = found >= 0 ? found : cursor;
    setRange(child, childStart, starts);
    cursor = childStart + child.raw.length;
    if (child.type === "list") annotateList(child, source, childStart, starts);
  }
}

function setRange(token: LineToken, start: number, starts: readonly number[]): void {
  token.line = lineAtOffset(starts, start);
  token.endLine = lineAtOffset(starts, start + Math.max(0, token.raw.length - 1));
}

/**
 * Índice del último bloque cuyo inicio queda por encima de `y`. Los bloques
 * anidados van después de su contenedor, así que el más específico gana.
 */
export function pickBlockIndex(blocks: readonly BlockBox[], y: number): number {
  if (blocks.length === 0) return -1;

  let index = 0;
  for (const [position, block] of blocks.entries()) {
    if (block.top <= y) index = position;
  }
  return index;
}

/** Interpola la línea dentro de un bloque largo según la altura recorrida. */
export function interpolateLine(block: BlockBox, y: number): number {
  const height = block.bottom - block.top;
  const fraction = height > 0 ? Math.min(1, Math.max(0, (y - block.top) / height)) : 0;
  return Math.round(block.line + (block.endLine - block.line) * fraction);
}

export function sourceLineAt(blocks: readonly BlockBox[], y: number): number | undefined {
  const index = pickBlockIndex(blocks, y);
  const block = blocks[index];
  return block ? interpolateLine(block, y) : undefined;
}
