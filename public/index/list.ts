// Vista de lista de la portada: documentos agrupados por carpeta (y recientes),
// con foco de navegación estilo Vim y filtro difuso. Es una proyección del
// estado compartido (`state.ts`): muta foco, selección y filtro; el conjunto de
// documentos vive fuera y el filtro solo oculta elementos del DOM.

import { fuzzyMatch } from "../fuzzy.ts";
// Import del asset: el bundler lo sirve con URL estable (dev y bundle).
import logoUrl from "../img/logo-full.png";
import { viewUrl } from "../render.ts";
import { splitPath } from "./model.ts";
import type { IndexState } from "./state.ts";

export interface ListEntry {
  path: string;
  /** Se muestra en la sección «Recent» (pestañas abiertas). */
  recent?: boolean;
}

export interface IndexListOptions {
  state: IndexState;
  onOpen: (path: string) => void;
  /** Cambio de selección (documento enfocado, o `null`). */
  onSelect?: (path: string | null) => void;
}

export interface IndexList {
  readonly element: HTMLElement;
  setEntries(entries: readonly ListEntry[]): void;
  move(count: number): void;
  top(): void;
  bottom(): void;
  open(): void;
  openFilter(): void;
  cancel(): void;
  /** Llevar la vista al elemento enfocado (tras montar o reconciliar). */
  reveal(): void;
}

export function createIndexList(options: IndexListOptions): IndexList {
  const { state, onOpen, onSelect } = options;

  const root = document.createElement("div");
  root.className = "index";
  const header = document.createElement("div");
  header.className = "index-header";
  const logo = document.createElement("img");
  logo.className = "index-logo";
  logo.src = logoUrl;
  logo.alt = "MarkVi";
  const hint = document.createElement("p");
  hint.className = "index-hint";
  hint.textContent = "j/k move · gg/G ends · / filter · Enter open · space + f find";
  header.append(logo, hint);

  // Barra de filtro: un <input> real, así el navegador gestiona la escritura y
  // el manejador global de teclas ignora lo que se teclea dentro.
  const filterBar = document.createElement("div");
  filterBar.className = "index-filter";
  filterBar.hidden = true;
  const filterPrompt = document.createElement("span");
  filterPrompt.textContent = "/";
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.spellcheck = false;
  filterInput.autocomplete = "off";
  filterInput.placeholder = "filter files";
  filterBar.append(filterPrompt, filterInput);
  header.append(filterBar);
  root.append(header);

  const body = document.createElement("div");
  root.append(body);

  /** Enlaces visibles en orden de documento. */
  const visible = () =>
    [...body.querySelectorAll<HTMLAnchorElement>("a[data-path]")].filter(
      (link) => !link.closest("li")!.hidden,
    );

  const focusedLink = () => body.querySelector<HTMLAnchorElement>("a.focused");

  function setFocused(link: HTMLAnchorElement | null) {
    for (const other of body.querySelectorAll<HTMLAnchorElement>("a.focused")) {
      other.classList.remove("focused");
    }
    if (!link) {
      state.focusedNodeId = null;
      return;
    }
    const path = link.dataset.path ?? null;
    link.classList.add("focused");
    // En la lista el foco y la selección coinciden: solo hay documentos.
    state.focusedNodeId = path;
    state.selectedPath = path;
    onSelect?.(path);
    link.scrollIntoView({ block: "nearest" });
  }

  let entries: readonly ListEntry[] = [];

  function render() {
    body.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "index-empty";
      empty.textContent = "No .md files in this directory.";
      body.append(empty);
      return;
    }

    const recents = entries.filter((entry) => entry.recent);
    if (recents.length > 0) body.append(group("Recent", recents));

    const groups = new Map<string, ListEntry[]>();
    for (const entry of entries) {
      if (entry.recent) continue;
      const { dir } = splitPath(entry.path);
      const bucket = groups.get(dir);
      if (bucket) bucket.push(entry);
      else groups.set(dir, [entry]);
    }
    for (const [dir, items] of groups) body.append(group(dir || "Root", items));
  }

  function group(title: string, items: readonly ListEntry[]) {
    const section = document.createElement("section");
    section.className = "index-group";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const list = document.createElement("ul");
    list.className = "files";
    for (const entry of items) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const { dir, name } = splitPath(entry.path);
      if (dir) {
        // Nombre y ruta a la vista: la carpeta en gris, el archivo en claro.
        const dirSpan = document.createElement("span");
        dirSpan.className = "index-dir";
        dirSpan.textContent = `${dir}/`;
        link.append(dirSpan);
      }
      link.append(document.createTextNode(name));
      link.dataset.path = entry.path;
      link.href = viewUrl(entry.path);
      link.title = entry.path;
      item.append(link);
      list.append(item);
    }
    section.append(heading, list);
    return section;
  }

  /** Reaplica el filtro vigente tras reconstruir el DOM. */
  function applyFilter(query: string) {
    state.filter = query;
    const terms = query.trim().split(/\s+/).filter(Boolean);
    for (const section of body.querySelectorAll<HTMLElement>(".index-group")) {
      let count = 0;
      for (const link of section.querySelectorAll<HTMLAnchorElement>("a[data-path]")) {
        const match =
          terms.length === 0 ||
          terms.every((term) => fuzzyMatch(term, link.dataset.path ?? "") !== null);
        link.closest("li")!.hidden = !match;
        if (match) count++;
      }
      section.hidden = count === 0;
    }
    // El foco no puede quedar en un elemento filtrado: salta al primero visible.
    if (focusedLink()?.closest("li")?.hidden) setFocused(visible()[0] ?? null);
  }

  function restore() {
    if (!state.focusedNodeId) return;
    const link = body.querySelector<HTMLAnchorElement>(
      `a[data-path="${CSS.escape(state.focusedNodeId)}"]`,
    );
    if (link && !link.closest("li")!.hidden) setFocused(link);
  }

  function step(links: readonly HTMLAnchorElement[], delta: number) {
    if (links.length === 0) return;
    const current = focusedLink();
    const index = current ? links.indexOf(current) : -1;
    // Sin foco, `j` y `k` llevan al primer elemento; con foco, con tope en los extremos.
    const next = index < 0
      ? 0
      : Math.min(links.length - 1, Math.max(0, index + delta));
    setFocused(links[next]!);
  }

  function open() {
    const current = focusedLink();
    if (current) {
      onOpen(current.dataset.path ?? "");
      return;
    }
    // Sin foco, `Enter` solo selecciona el primero: abrir de golpe sería agresivo.
    setFocused(visible()[0] ?? null);
  }

  function openFilter() {
    filterBar.hidden = false;
    filterInput.value = state.filter;
    filterInput.focus();
  }

  function closeFilter() {
    filterBar.hidden = true;
    filterInput.blur();
    filterInput.value = "";
    applyFilter("");
  }

  filterInput.addEventListener("input", () => applyFilter(filterInput.value));
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // Primera pulsación limpia; con el filtro ya vacío, se sale de él.
      if (filterInput.value) {
        filterInput.value = "";
        applyFilter("");
      } else {
        closeFilter();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  });

  return {
    element: root,

    setEntries(next) {
      entries = next;
      render();
      applyFilter(state.filter);
      restore();
    },

    move(count) {
      step(visible(), count);
    },

    top() {
      setFocused(visible()[0] ?? null);
    },

    bottom() {
      const links = visible();
      setFocused(links[links.length - 1] ?? null);
    },

    open,

    openFilter,

    cancel() {
      if (!filterBar.hidden || state.filter) closeFilter();
    },

    reveal() {
      focusedLink()?.scrollIntoView({ block: "nearest" });
    },
  };
}
