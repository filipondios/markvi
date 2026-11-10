import { createEditor, type EditorSession } from "./editor.ts";
import { renderMarkdown, viewUrl, VIEW_PREFIX } from "./render.ts";

const content = document.querySelector<HTMLElement>("#content")!;
const crumb = document.querySelector<HTMLElement>("#path")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode")!;
const dirtyIndicator = document.querySelector<HTMLElement>("#dirty")!;
const themePreference = matchMedia("(prefers-color-scheme: dark)");

// `null` es el índice de archivos; `undefined`, que aún no se ha pintado nada.
let shown: string | null | undefined;
let request = 0;
let editor: EditorSession | undefined;
let editable = false;
let rawDocument = "";
let draft = "";
let dirty = false;
let bodyScroll = 0;
let savedPosition = 0;
const positions = new Map<string, number>();
let leaderPending = false;
let leaderTimer = 0;

function currentPath() {
  if (!location.pathname.startsWith(VIEW_PREFIX)) return null;
  const encoded = location.pathname.slice(VIEW_PREFIX.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Error ${response.status}`);
  }
  return response;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function updateDirty(next: boolean) {
  dirty = next;
  dirtyIndicator.textContent = dirty ? "Sin guardar" : "Guardado";
  dirtyIndicator.classList.toggle("is-dirty", dirty);
  modeButton.textContent = editor ? "Vista" : "Editar";
  modeButton.setAttribute("aria-pressed", String(!!editor));
  modeButton.setAttribute("aria-label", editor ? "Volver a vista (Esc)" : "Editar (e)");
  modeButton.title = editor ? "Volver a vista (Esc)" : "Editar (e)";
  modeButton.disabled = !editable;
  const path = currentPath();
  if (path) document.title = `${dirty ? "● " : ""}${path} · markvi`;
}

function setTheme() {
  editor?.setDark(themePreference.matches);
}

themePreference.addEventListener("change", setTheme);

function buildEditor() {
  const host = element("div", "", "editor-host");
  content.replaceChildren(host);
  content.classList.add("editing");
  editor = createEditor(host, draft, {
    cursor: savedPosition,
    onChange(value) {
      draft = value;
      updateDirty(draft !== rawDocument);
    },
    onSave: () => void saveDraft(),
    onExit: () => void exitEditor(),
  });
  setTheme();
  updateDirty(dirty);
}

function leaveEditor() {
  if (!editor) return;
  savedPosition = editor.view.state.selection.main.head;
  const path = currentPath();
  if (path) positions.set(path, savedPosition);
  editor.destroy();
  editor = undefined;
  // El DOM contiene el editor: forzar que `show()` vuelva a pintar la vista.
  shown = undefined;
  content.classList.remove("editing");
}

function enterEditor() {
  if (!editable || !currentPath() || editor) return;
  bodyScroll = scrollY;
  draft = rawDocument;
  savedPosition = Math.min(savedPosition, draft.length);
  updateDirty(false);
  buildEditor();
  updateDirty(dirty);
}

async function saveDraft() {
  const path = currentPath();
  if (!path || !editor) return;
  draft = editor.view.state.doc.toString();
  const cursor = editor.view.state.selection.main.head;
  try {
    await api(`/api/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: draft,
    });
    rawDocument = draft;
    savedPosition = cursor;
    updateDirty(false);
  } catch (error) {
    alert(`No se pudo guardar: ${error instanceof Error ? error.message : String(error)}`);
    editor?.view.focus();
  }
}

async function exitEditor() {
  if (!editor) return;
  await saveDraft();
  if (dirty) return;
  leaveEditor();
  await show(bodyScroll);
}

function buildIndex(files: string[]) {
  const fragment = document.createDocumentFragment();
  fragment.append(element("h1", "Archivos"));
  if (files.length === 0) {
    fragment.append(element("p", "No hay archivos .md en este directorio.", "muted"));
    return fragment;
  }

  const list = element("ul", "", "files");
  for (const file of files) {
    const link = element("a", file);
    link.href = viewUrl(file);
    const item = document.createElement("li");
    item.append(link);
    list.append(item);
  }
  fragment.append(list);
  return fragment;
}

async function loadFile(path: string) {
  const response = await api(`/api/file?path=${encodeURIComponent(path)}`);
  return response.text();
}

function scrollToHash() {
  const encoded = location.hash.slice(1);
  let id = encoded;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    // Un fragmento inválido simplemente no coincide con ningún título.
  }
  const target = id ? content.querySelector(`#${CSS.escape(id)}`) : null;
  if (target) target.scrollIntoView();
  else scrollTo(0, 0);
}

async function show(scroll?: number) {
  const id = ++request;
  const path = currentPath();

  if (editor) leaveEditor();
  if (path !== shown) {
    let nodes: Node;
    try {
      if (path === null) {
        const { files } = (await (await api("/api/tree")).json()) as { files: string[] };
        nodes = buildIndex(files);
        rawDocument = "";
        editable = false;
      } else {
        rawDocument = await loadFile(path);
        nodes = renderMarkdown(rawDocument, path);
        editable = true;
      }
    } catch (error) {
      nodes = element("p", error instanceof Error ? error.message : String(error), "error");
      rawDocument = "";
      editable = false;
    }
    if (id !== request) return;

    content.replaceChildren(nodes);
    shown = path;
    crumb.textContent = path ?? "";
    document.title = path ? `${path} · markvi` : "markvi";
    savedPosition = path ? (positions.get(path) ?? 0) : 0;
    draft = rawDocument;
    updateDirty(false);
  }

  if (scroll === undefined) scrollToHash();
  else scrollTo(0, scroll);
}

function navigate(url: URL) {
  if (dirty && !confirm("Hay cambios sin guardar. ¿Descartarlos y cambiar de archivo?")) return;
  if (url.href !== location.href) {
    history.replaceState({ scroll: scrollY }, "");
    history.pushState(null, "", url);
  }
  updateDirty(false);
  void show();
}

modeButton.addEventListener("click", () => {
  if (editor) void exitEditor();
  else enterEditor();
});

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return;

  const url = new URL(link.href);
  if (url.origin !== location.origin) return;
  if (url.pathname !== "/" && !url.pathname.startsWith(VIEW_PREFIX)) return;

  event.preventDefault();
  navigate(url);
});

window.addEventListener("popstate", (event) => {
  if (dirty && !confirm("Hay cambios sin guardar. ¿Descartarlos y continuar?")) {
    history.pushState({ scroll: scrollY }, "", location.href);
    return;
  }
  updateDirty(false);
  void show(event.state?.scroll);
});

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  const inEditor = editor?.view.dom.contains(target as Node) ?? false;
  if (inEditor || (target instanceof HTMLElement && target.isContentEditable)) return;

  if (leaderPending) {
    leaderPending = false;
    clearTimeout(leaderTimer);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const links = [...document.querySelectorAll<HTMLAnchorElement>("#content a[href^='/view/']")];
      const index = links.findIndex((link) => link.pathname === location.pathname);
      const next = links[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        navigate(new URL(next.href));
      }
    }
    return;
  }

  if (event.key === " " && !editor) {
    leaderPending = true;
    leaderTimer = window.setTimeout(() => { leaderPending = false; }, 800);
    event.preventDefault();
    return;
  }

  if (event.key.toLowerCase() === "e" && !editor && editable && currentPath()) {
    event.preventDefault();
    enterEditor();
  }
});

history.scrollRestoration = "manual";
void show();
