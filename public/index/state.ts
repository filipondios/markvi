// Estado compartido de la portada. Las vistas (lista, grafos) son proyecciones
// de este estado, y la reconciliación lo mantiene coherente con el disco tras
// cada actualización del watcher. Identidad por ruta, nunca por índice.

import { createDocs, indexFolders, type IndexDoc, type IndexView } from "./model.ts";

export interface IndexState {
  /** Vista activa. */
  view: IndexView;
  /** Documento seleccionado, o `null`. Puede ser una carpeta la que tenga el foco. */
  selectedPath: string | null;
  /** Elemento que recibe el foco de navegación (documento o carpeta, por ruta). */
  focusedNodeId: string | null;
  /** Carpetas expandibles abiertas, por ruta. */
  expandedPaths: string[];
  /** Filtro temporal de la lista; no se persiste inicialmente. */
  filter: string;
  previewVisible: boolean;
  /** `null` significa que el preview sigue a la selección. */
  previewPinnedPath: string | null;
}

export function createIndexState(): IndexState {
  return {
    view: "list",
    selectedPath: null,
    focusedNodeId: null,
    expandedPaths: [],
    filter: "",
    previewVisible: false,
    previewPinnedPath: null,
  };
}

/** Primer documento de `docs` cuya carpeta es `dir`, o `null`. */
function firstInDir(docs: readonly IndexDoc[], dir: string): string | null {
  return docs.find((doc) => doc.dir === dir)?.path ?? null;
}

/**
 * Documento válido más cercano a `fromDir`: un hermano de la misma carpeta, si
 * no, el primero de una carpeta ancestro, si no, el primero global. Con el
 * conjunto vacío, `null`.
 */
function nearestDoc(docs: readonly IndexDoc[], fromDir: string): string | null {
  for (let dir = fromDir; ; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    const doc = firstInDir(docs, dir);
    if (doc) return doc;
    if (!dir) return null;
  }
}

/** Carpeta contenedora de una ruta (`""` en la raíz). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Reconcilia el estado con la nueva lista de archivos: la selección que sigue
 * existiendo se conserva aunque el orden cambie; si desapareció, salta al
 * documento cercano válido. El foco hace lo propio hacia la carpeta padre, y
 * las carpetas y el preview fijado ya inexistentes se descartan. Actualiza
 * `state` in situ y lo devuelve: las vistas guardan su referencia.
 */
export function reconcileIndexState(
  state: IndexState,
  files: readonly string[],
): IndexState {
  const docs = createDocs(files);
  const folders = indexFolders(files);
  const selected = state.selectedPath;

  let focused = state.focusedNodeId;
  if (focused !== null && !docs.some((doc) => doc.path === focused) && !folders.has(focused)) {
    // El nodo enfocado desapareció: el padre válido más cercano, o nada.
    let dir = dirOf(focused);
    focused = null;
    while (dir) {
      if (folders.has(dir)) {
        focused = dir;
        break;
      }
      dir = dirOf(dir);
    }
  }

  return Object.assign(state, {
    selectedPath: selected === null || docs.some((doc) => doc.path === selected)
      ? selected
      : nearestDoc(docs, dirOf(selected)),
    focusedNodeId: focused,
    expandedPaths: state.expandedPaths.filter((path) => folders.has(path)),
    previewPinnedPath: state.previewPinnedPath !== null && docs.some((doc) => doc.path === state.previewPinnedPath)
      ? state.previewPinnedPath
      : null,
  });
}
