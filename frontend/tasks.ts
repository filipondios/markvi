// Casillas de tareas (`- [ ]` / `- [x]`) en el Markdown fuente. Son funciones
// puras: la vista decide qué línea tocar y aquí solo se edita el texto.

import { lineStarts } from "./lines.ts";

// Marcador de lista (con sangría y prefijos de cita) seguido de `[ ]`, `[x]` o
// `[X]`. Tras el corchete debe haber espacio o fin de línea, como en GFM.
const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\](?=\s|$)/;

export interface TaskChange {
  /** Documento completo con la casilla ya cambiada. */
  text: string;
  /** Estado de la casilla tras el cambio. */
  checked: boolean;
}

function lineBounds(source: string, line: number): { from: number; to: number } | null {
  const starts = lineStarts(source);
  if (!Number.isInteger(line) || line < 1 || line > starts.length) return null;
  const from = starts[line - 1]!;
  const next = source.indexOf("\n", from);
  return { from, to: next < 0 ? source.length : next };
}

/** `true` / `false` según la casilla de esa línea, o `null` si no es una tarea. */
export function taskState(source: string, line: number): boolean | null {
  const bounds = lineBounds(source, line);
  if (!bounds) return null;
  const match = TASK_LINE.exec(source.slice(bounds.from, bounds.to));
  return match ? match[2] !== " " : null;
}

/**
 * Marca o desmarca la tarea de `line` (1-based). Sin `checked` la invierte.
 * Devuelve `null` si la línea no contiene una casilla.
 */
export function toggleTask(source: string, line: number, checked?: boolean): TaskChange | null {
  const bounds = lineBounds(source, line);
  if (!bounds) return null;

  const match = TASK_LINE.exec(source.slice(bounds.from, bounds.to));
  if (!match) return null;

  const next = checked ?? match[2] === " ";
  const at = bounds.from + match[1]!.length;
  return { text: `${source.slice(0, at)}${next ? "x" : " "}${source.slice(at + 1)}`, checked: next };
}
