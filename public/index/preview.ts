// Vista previa del documento seleccionado en la portada: ventana cuadrada fija
// en la esquina inferior derecha. Renderiza con el mismo pipeline que la
// vista principal (sin interacción). El elemento vive dentro de la portada,
// así que desaparece con ella al abrir un documento.

import { renderMarkdown } from "../render.ts";

export interface IndexPreview {
  readonly element: HTMLElement;
  show(path: string | null): void;
}

export function createIndexPreview(): IndexPreview {
  const root = document.createElement("aside");
  root.className = "index-preview";
  root.hidden = true;
  const body = document.createElement("div");
  body.className = "index-preview-body";
  root.append(body);

  let current: string | null = null;
  let token = 0;

  return {
    element: root,

    async show(path) {
      // Misma selección ya en pantalla: no rehacer el fetch.
      if (path === current && !root.hidden) return;
      current = path;
      const ticket = ++token;
      if (path === null) {
        root.hidden = true;
        body.replaceChildren();
        return;
      }
      root.hidden = false;
      body.replaceChildren("Loading…");
      try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        if (ticket !== token) return; // llegó una selección más nueva
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const fragment = renderMarkdown(await response.text(), path);
        if (ticket !== token) return;
        body.replaceChildren(fragment);
        body.scrollTop = 0;
      } catch {
        if (ticket !== token) return;
        body.replaceChildren("Preview unavailable.");
      }
    },
  };
}
