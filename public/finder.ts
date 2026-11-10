import { fuzzySearch, type FuzzyResult } from "./fuzzy.ts";
import { renderMarkdown } from "./render.ts";

export interface FinderOptions {
  /** Lista actual de archivos `.md` del directorio raíz. */
  list: () => Promise<string[]>;
  /** Contenido crudo de un archivo, para la vista previa. */
  read: (path: string) => Promise<string>;
  /** Abre el archivo elegido con `Enter`. */
  open: (path: string) => void;
}

export interface Finder {
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

function highlight(text: string, positions: readonly number[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const matched = new Set(positions);
  let buffer = "";
  let inMatch = false;

  const flush = () => {
    if (!buffer) return;
    if (inMatch) {
      const mark = element("mark", "finder-match", buffer);
      fragment.append(mark);
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

export function createFinder(options: FinderOptions): Finder {
  const backdrop = element("div", "finder-backdrop");
  backdrop.hidden = true;

  const dialog = element("div", "finder");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Buscar archivo");

  const input = document.createElement("input");
  input.type = "search";
  input.className = "finder-input";
  input.placeholder = "Buscar archivo…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Buscar archivo");
  input.setAttribute("aria-controls", "finder-results");
  input.setAttribute("aria-expanded", "true");

  const count = element("span", "finder-count");

  const search = element("div", "finder-search");
  search.append(input, count);

  const list = element("ul", "finder-results");
  list.id = "finder-results";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Archivos");

  const previewTitle = element("div", "finder-preview-title");
  const previewBody = element("div", "finder-preview-body");
  const preview = element("div", "finder-preview");
  preview.append(previewTitle, previewBody);

  const body = element("div", "finder-body");
  body.append(list, preview);

  const hint = element(
    "div",
    "finder-hint",
    "↑↓ o Ctrl+j/k mover · Enter abrir · Esc cerrar",
  );

  dialog.append(search, body, hint);
  backdrop.append(dialog);
  document.body.append(backdrop);

  let opened = false;
  let files: string[] = [];
  let results: FuzzyResult[] = [];
  let selected = -1;
  let loadToken = 0;
  let previewToken = 0;
  let previewTimer = 0;
  let previousFocus: Element | null = null;
  const previewCache = new Map<string, string>();

  function paint() {
    const fragment = document.createDocumentFragment();

    results.forEach((result, index) => {
      const item = element("li", "finder-result");
      item.id = `finder-option-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selected));
      if (index === selected) item.classList.add("is-selected");

      const slash = result.path.lastIndexOf("/");
      const split = slash + 1;
      const dir = result.path.slice(0, split);
      const name = result.path.slice(split);

      if (dir) {
        const dirNode = element("span", "finder-dir");
        dirNode.append(highlight(dir, result.positions.filter((position) => position < split)));
        item.append(dirNode);
      }

      const nameNode = element("span", "finder-name");
      nameNode.append(
        highlight(
          name,
          result.positions
            .filter((position) => position >= split)
            .map((position) => position - split),
        ),
      );
      item.append(nameNode);

      item.addEventListener("mouseenter", () => select(index));
      item.addEventListener("click", () => {
        select(index);
        choose();
      });
      fragment.append(item);
    });

    list.replaceChildren(fragment);
    count.textContent = files.length > 0 ? `${results.length}/${files.length}` : "";

    if (selected >= 0) {
      input.setAttribute("aria-activedescendant", `finder-option-${selected}`);
      list.children[selected]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function updateResults(reset: boolean) {
    results = fuzzySearch(input.value, files);
    if (reset) selected = results.length > 0 ? 0 : -1;
    else if (results.length === 0) selected = -1;
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
      previewBody.replaceChildren(
        element("p", "muted", input.value ? "Sin resultados." : "No hay archivos .md."),
      );
      return;
    }

    const path = result.path;
    previewTitle.textContent = path;

    let source = previewCache.get(path);
    if (source === undefined) {
      previewBody.replaceChildren(element("p", "muted", "Cargando…"));
      try {
        source = await options.read(path);
        previewCache.set(path, source);
      } catch (error) {
        if (token !== previewToken) return;
        previewBody.replaceChildren(
          element("p", "error", error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }

    if (token !== previewToken) return;
    previewBody.replaceChildren(renderMarkdown(source, path));
    previewBody.scrollTop = 0;
  }

  function choose() {
    const result = results[selected];
    if (!result) return;
    const path = result.path;
    close();
    options.open(path);
  }

  function open() {
    if (opened) return;
    opened = true;
    previousFocus = document.activeElement;
    previewCache.clear();
    files = [];
    results = [];
    selected = -1;
    input.value = "";
    count.textContent = "";
    previewTitle.textContent = "";
    previewBody.replaceChildren(element("p", "muted", "Cargando archivos…"));
    list.replaceChildren();
    input.removeAttribute("aria-activedescendant");
    backdrop.hidden = false;
    document.body.classList.add("finder-open");
    input.focus();
    input.select();

    const token = ++loadToken;
    options.list().then(
      (paths) => {
        if (token !== loadToken || !opened) return;
        files = paths;
        updateResults(true);
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
