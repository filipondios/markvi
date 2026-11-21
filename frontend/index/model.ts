// Modelo común de documentos de la portada. La identidad estable es la ruta
// relativa (la misma que devuelve /api/tree); nunca un índice de array. No
// importa nada del DOM: lo consumen las vistas y la reconciliación.

import { normalizePath, splitPath } from "../shared/paths.ts";

/** Proyección del modelo de documentos que muestra la portada. */
export type IndexView = "list";

export interface IndexDoc {
  /** Ruta relativa normalizada (`/` como separador, sin `./` ni `/` inicial). */
  readonly path: string;
  /** Carpeta contenedora; `""` para la raíz. */
  readonly dir: string;
  /** Nombre base con extensión. */
  readonly name: string;
}

/**
 * Documentos del índice, ordenados por ruta: el orden estable es el que permite
 * que «vecino más cercano» y «primero/último» no dependan de cómo llegó la lista.
 */
export function createDocs(files: readonly string[]): IndexDoc[] {
  const docs: IndexDoc[] = [];
  for (const raw of new Set(files)) {
    const path = normalizePath(raw);
    if (!path) continue;
    docs.push({ path, ...splitPath(path) });
  }
  return docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Carpetas implícitas en las rutas (todos los ancestros, raíz excluida). */
export function indexFolders(files: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const doc of createDocs(files)) {
    let dir = doc.dir;
    while (dir) {
      folders.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return folders;
}
