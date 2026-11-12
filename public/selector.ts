// Selector modal genérico, al estilo Telescope: una lista con búsqueda difusa,
// preview opcional y una acción al elegir. Lo usan el buscador de archivos y el
// índice del documento (TOC).

import { fuzzySearchItems, type FuzzyItemResult } from "./fuzzy.ts";

export interface SelectorItem<T = unknown> {
  /** Clave estable para cachear el preview. */
  key: string;
  /** Texto visible y base de la búsqueda. */
  label: string;
  /** Texto alternativo para la búsqueda (por defecto, `label`). */
  search?: string;
  data: T;
}

export interface SelectorOptions<T> {
  /** Etiqueta accesible del diálogo. */
  title: string;
  placeholder: string;
  /** Etiqueta accesible de la lista. */
  listLabel: string;
  /** Pista de teclas del pie. */
  hint: string;
  /** Mensaje cuando no hay elementos o no hay coincidencias. */
  empty: string | ((query: string) => string);
  items: () => Promise<readonly SelectorItem<T>[]> | readonly SelectorItem<T>[];
  /** Índice que debe quedar seleccionado al abrir (por defecto, el primero). */
  initial?: (items: readonly SelectorItem<T>[]) => number;
  /** Renderiza una fila; `positions` son los índices coincidentes en `label`. */
  renderItem: (item: SelectorItem<T>, positions: readonly number[]) => Node;
  /** Preview opcional; se llama con retraso al cambiar la selección. */
  preview?: (item: SelectorItem<T>) => Promise<Node | string> | Node | string;
  previewTitle?: (item: SelectorItem<T>) => string;
  choose: (item: SelectorItem<T>) => void;
  count?: (shown: number, total: number) => string;
}

export interface Selector {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

const PREVIEW_DELAY = 90;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Resalta en `text` los índices de `positions` con `<mark>`. */
export function highlight(text: string, positions: readonly number[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const matched = new Set(positions);
  let buffer = "";
  let inMatch = false;

  const flush = () => {
    if (!buffer) return;
    if (inMatch) {
      fragment.append(element("mark", "finder-match", buffer));
    } else {
      fragment.append(buffer);
    }
    buffer = "";
  };

  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i);
    if (isMatch !== inMatch) {
      flush();
      inMatch = isMatch;
    }
    buffer += text[i];
  }
  flush();
  return fragment;
}

export function createSelector<T>(options: SelectorOptions<T>): Selector {
  const backdrop = element("div", "finder-backdrop");
  backdrop.hidden = true;

  const dialog = element("div", "finder");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", options.title);

  const input = document.createElement("input");
  input.type = "search";
  input.className = "finder-input";
  input.placeholder = options.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", options.title);
  input.setAttribute("aria-controls", "finder-results");
  input.setAttribute("aria-expanded", "true");

  const count = element("span", "finder-count");

  const search = element("div", "finder-search");
  search.append(input, count);

  const list = element("ul", "finder-results");
  list.id = "finder-results";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", options.listLabel);

  const previewTitle = element("div", "finder-preview-title");
  const previewBody = element("div", "finder-preview-body");
  const preview = element("div", "finder-preview");
  preview.append(previewTitle, previewBody);

  const body = element("div", "finder-body");
  body.append(list, preview);

  const hint = element("div", "finder-hint", options.hint);

  dialog.append(search, body, hint);
  backdrop.append(dialog);
  document.body.append(backdrop);

  if (!options.preview) {
    preview.hidden = true;
    body.classList.add("finder-body-single");
  }

  let opened = false;
  let items: SelectorItem<T>[] = [];
  let results: FuzzyItemResult<SelectorItem<T>>[] = [];
  let selected = -1;
  let loadToken = 0;
  let previewToken = 0;
  let previewTimer = 0;
  let previousFocus: Element | null = null;
  const previewCache = new Map<string, Node | string>();

  const emptyMessage = () =>
    typeof options.empty === "function" ? options.empty(input.value) : options.empty;

  function paint() {
    const fragment = document.createDocumentFragment();

    results.forEach((result, index) => {
      const item = element("li", "finder-result");
      item.id = `finder-option-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selected));
      if (index === selected) item.classList.add("is-selected");

      item.append(options.renderItem(result.item, result.positions));
      item.addEventListener("mouseenter", () => select(index));
      item.addEventListener("click", () => {
        select(index);
        choose();
      });
      fragment.append(item);
    });

    list.replaceChildren(fragment);
    count.textContent = options.count?.(results.length, items.length) ?? "";

    if (selected >= 0) {
      input.setAttribute("aria-activedescendant", `finder-option-${selected}`);
      list.children[selected]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function updateResults(reset: boolean, initial?: number) {
    results = fuzzySearchItems(input.value, items, (item) => item.search ?? item.label);
    if (reset) {
      const start = initial ?? 0;
      selected = results.length > 0 ? Math.min(Math.max(start, 0), results.length - 1) : -1;
    } else if (results.length === 0) selected = -1;
    else selected = Math.min(Math.max(selected, 0), results.length - 1);

    paint();
    schedulePreview();
  }

  function select(index: number) {
    if (index === selected || index < 0 || index >= results.length) return;
    selected = index;

    Array.from(list.children).forEach((item, position) => {
      item.classList.toggle("is-selected", position === selected);
      item.setAttribute("aria-selected", String(position === selected));
    });

    input.setAttribute("aria-activedescendant", `finder-option-${selected}`);
    list.children[selected]?.scrollIntoView({ block: "nearest" });
    schedulePreview();
  }

  function move(delta: number) {
    if (results.length === 0) return;
    select((selected + delta + results.length) % results.length);
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => void updatePreview(), PREVIEW_DELAY);
  }

  async function updatePreview() {
    const token = ++previewToken;
    const result = results[selected];

    if (!result) {
      previewTitle.textContent = "";
      previewBody.replaceChildren(element("p", "muted", emptyMessage()));
      return;
    }

    const item = result.item;
    previewTitle.textContent = options.previewTitle?.(item) ?? "";

    if (!options.preview) {
      previewBody.replaceChildren();
      return;
    }

    let cached = previewCache.get(item.key);
    if (cached === undefined) {
      previewBody.replaceChildren(element("p", "muted", "Loading…"));
      try {
        cached = await options.preview(item);
        previewCache.set(item.key, cached);
      } catch (error) {
        if (token !== previewToken) return;
        previewBody.replaceChildren(
          element("p", "error", error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }

    if (token !== previewToken) return;
    previewBody.replaceChildren(
      typeof cached === "string" ? element("p", "muted", cached) : cached.cloneNode(true),
    );
    previewBody.scrollTop = 0;
  }

  function choose() {
    const result = results[selected];
    if (!result) return;
    const item = result.item;
    close();
    options.choose(item);
  }

  function open() {
    if (opened) return;
    opened = true;
    previousFocus = document.activeElement;
    previewCache.clear();
    items = [];
    results = [];
    selected = -1;
    input.value = "";
    count.textContent = "";
    previewTitle.textContent = "";
    previewBody.replaceChildren(element("p", "muted", "Loading…"));
    list.replaceChildren();
    input.removeAttribute("aria-activedescendant");
    backdrop.hidden = false;
    document.body.classList.add("finder-open");
    input.focus();
    input.select();

    const token = ++loadToken;
    Promise.resolve()
      .then(() => options.items())
      .then(
        (loaded) => {
          if (token !== loadToken || !opened) return;
          items = [...loaded];
          updateResults(true, options.initial?.(items));
        },
        (error) => {
          if (token !== loadToken || !opened) return;
          previewBody.replaceChildren(
            element("p", "error", error instanceof Error ? error.message : String(error)),
          );
        },
      );
  }

  function close() {
    if (!opened) return;
    opened = false;
    loadToken++;
    previewToken++;
    clearTimeout(previewTimer);
    backdrop.hidden = true;
    document.body.classList.remove("finder-open");
    input.blur();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
    previousFocus = null;
  }

  input.addEventListener("input", () => updateResults(true));

  backdrop.addEventListener("mousedown", (event) => {
    if (event.target !== backdrop) return;
    event.preventDefault();
    close();
  });

  // Los enlaces de la vista previa no deben navegar mientras el modal está abierto.
  previewBody.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
  });

  document.addEventListener("keydown", (event) => {
    if (!opened || event.isComposing) return;

    const key = event.key;
    const control = event.ctrlKey || event.metaKey;

    if (key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (key === "Enter") {
      event.preventDefault();
      choose();
      return;
    }

    if (key === "ArrowDown" || (control && key.toLowerCase() === "j")) {
      event.preventDefault();
      move(1);
      return;
    }

    if (key === "ArrowUp" || (control && key.toLowerCase() === "k")) {
      event.preventDefault();
      move(-1);
      return;
    }

    if (key === "Home") {
      event.preventDefault();
      select(0);
      return;
    }

    if (key === "End") {
      event.preventDefault();
      select(results.length - 1);
      return;
    }

    if (key === "Tab") {
      event.preventDefault();
      input.focus();
    }
  });

  return {
    get isOpen() {
      return opened;
    },
    open,
    close,
  };
}
