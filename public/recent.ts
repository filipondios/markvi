// Archivos abiertos recientemente. Es una lista ordenada (el más reciente
// primero) que se guarda en `localStorage`; el contenido guardado puede estar
// corrupto o ser antiguo, así que se valida al leerlo.

import { isSafePath } from "./tabstore.ts";

export const MAX_RECENT = 50;

/** Mueve `path` al principio (sin duplicados) y recorta la lista. */
export function recordVisit(list: readonly string[], path: string, max = MAX_RECENT): string[] {
  return [path, ...list.filter((entry) => entry !== path)].slice(0, max);
}

/** El archivo anterior: el más reciente que no sea el actual. */
export function alternatePath(list: readonly string[], current?: string): string | undefined {
  return list.find((entry) => entry !== current);
}

export function renameRecent(list: readonly string[], from: string, to: string): string[] {
  const result: string[] = [];
  for (const entry of list) {
    const next = entry === from ? to : entry;
    if (!result.includes(next)) result.push(next);
  }
  return result;
}

export function removeRecent(list: readonly string[], path: string): string[] {
  return list.filter((entry) => entry !== path);
}

/** Recientes que siguen existiendo, sin el archivo actual, del más reciente al más antiguo. */
export function recentChoices(
  list: readonly string[],
  existing: readonly string[],
  current?: string,
): string[] {
  const present = new Set(existing);
  return list.filter((entry) => entry !== current && present.has(entry));
}

export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];

  const result: string[] = [];
  for (const entry of stored) {
    if (typeof entry !== "string" || !isSafePath(entry) || result.includes(entry)) continue;
    result.push(entry);
    if (result.length >= MAX_RECENT) break;
  }
  return result;
}

export function serializeRecent(list: readonly string[]) {
  return JSON.stringify(list);
}
