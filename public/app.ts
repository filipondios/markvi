import { createEditor, type EditorSession } from "./editor.ts";
import { createFinder } from "./finder.ts";
import { createLeader } from "./keys.ts";
import { renderMarkdown, viewUrl, VIEW_PREFIX } from "./render.ts";
import { parseStoredTabs, serializeTabs, type TabMode } from "./tabstore.ts";

const content = document.querySelector<HTMLElement>("#content")!;
const crumb = document.querySelector<HTMLElement>("#path")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode")!;
const dirtyIndicator = document.querySelector<HTMLElement>("#dirty")!;
const tabBar = document.querySelector<HTMLElement>("#tabs")!;
const bar = document.querySelector<HTMLElement>("#bar")!;
const themePreference = matchMedia("(prefers-color-scheme: dark)");

type Mode = TabMode;

interface Tab {
  path: string;
  mode: Mode;
  /** Último contenido guardado en disco. */
  raw: string;
  /** Contenido actual; puede diferir de `raw` si hay cambios sin guardar. */
  draft: string;
  dirty: boolean;
  /** Scroll de la vista renderizada. */
  scroll: number;
  /** Cursor del editor. */
  cursor: number;
  loaded: boolean;
  error?: string;
}

const STORAGE_KEY = "markvi:tabs";

const tabs: Tab[] = [];
let active: Tab | null = null;
let request = 0;
let editor: EditorSession | undefined;
let editable = false;

function pathFromUrl(url: URL) {
  if (!url.pathname.startsWith(VIEW_PREFIX)) return null;
  const encoded = url.pathname.slice(VIEW_PREFIX.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function currentPath() {
  return pathFromUrl(new URL(location.href));
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

function findTab(path: string) {
  return tabs.find((tab) => tab.path === path);
}

function createTab(path: string, mode: Mode = "view"): Tab {
  const tab: Tab = {
    path,
    mode,
    raw: "",
    draft: "",
    dirty: false,
    scroll: 0,
    cursor: 0,
    loaded: false,
  };
  tabs.push(tab);
  persistTabs();
  return tab;
}

function ensureTab(path: string) {
  return findTab(path) ?? createTab(path);
}

function resetTab(tab: Tab) {
  tab.mode = "view";
  tab.raw = "";
  tab.draft = "";
  tab.dirty = false;
  tab.scroll = 0;
  tab.cursor = 0;
  tab.loaded = false;
  tab.error = undefined;
}

function persistTabs() {
  try {
    const stored = tabs.map((tab) => ({ path: tab.path, mode: tab.mode }));
    localStorage.setItem(STORAGE_KEY, serializeTabs(stored));
  } catch {
    // Si localStorage no está disponible, las pestañas siguen en memoria.
  }
}

function restoreTabs() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }

  for (const entry of parseStoredTabs(raw)) {
    if (findTab(entry.path)) continue;
    tabs.push({
      path: entry.path,
      mode: entry.mode,
      raw: "",
      draft: "",
      dirty: false,
      scroll: 0,
      cursor: 0,
      loaded: false,
    });
  }
}

function syncBarHeight() {
  document.documentElement.style.setProperty("--bar-height", `${bar.offsetHeight}px`);
}

function renderTabs() {
  tabBar.hidden = tabs.length === 0;
  const fragment = document.createDocumentFragment();

  for (const tab of tabs) {
    const item = element("div", "", "tab");
    item.dataset.path = tab.path;
    item.classList.toggle("is-active", tab === active);
    item.classList.toggle("is-dirty", tab.dirty);

    const link = document.createElement("a");
    link.className = "tab-link";
    link.href = viewUrl(tab.path);
    link.textContent = tab.path.split("/").pop() ?? tab.path;
    link.title = tab.path;
    link.setAttribute("role", "tab");
    link.setAttribute("aria-selected", String(tab === active));
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      switchTo(tab);
    });

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.title = `Cerrar ${tab.path}`;
    close.setAttribute("aria-label", `Cerrar ${tab.path}`);
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTab(tab);
    });

    item.append(link, close);
    fragment.append(item);
  }

  tabBar.replaceChildren(fragment);
  syncBarHeight();
}

function syncTabState() {
  for (const item of tabBar.querySelectorAll<HTMLElement>(".tab")) {
    const tab = item.dataset.path ? findTab(item.dataset.path) : undefined;
    if (!tab) continue;
    item.classList.toggle("is-active", tab === active);
    item.classList.toggle("is-dirty", tab.dirty);
    item.querySelector(".tab-link")?.setAttribute("aria-selected", String(tab === active));
  }
}

function updateDirty() {
  const tab = active;
  const dirty = tab?.dirty ?? false;
  dirtyIndicator.textContent = dirty ? "Sin guardar" : "Guardado";
  dirtyIndicator.classList.toggle("is-dirty", dirty);

  const editing = !!editor;
  modeButton.textContent = editing ? "Vista" : "Editar";
  modeButton.setAttribute("aria-pressed", String(editing));
  modeButton.setAttribute("aria-label", editing ? "Volver a vista (Esc)" : "Editar (e)");
  modeButton.title = editing ? "Volver a vista (Esc)" : "Editar (e)";
  modeButton.disabled = !tab || !editable;

  document.title = tab ? `${dirty ? "● " : ""}${tab.path} · markvi` : "markvi";
}

function setTheme() {
  editor?.setDark(themePreference.matches);
}

themePreference.addEventListener("change", setTheme);

function leaveEditor() {
  if (!editor || !active) return;
  active.cursor = editor.view.state.selection.main.head;
  active.draft = editor.view.state.doc.toString();
  active.dirty = active.draft !== active.raw;
  editor.destroy();
  editor = undefined;
  content.classList.remove("editing");
}

function enterEditor(tab: Tab) {
  if (tab !== active || editor || !editable || !tab.loaded || tab.error) return;

  const wasView = tab.mode === "view";
  tab.mode = "edit";
  if (wasView) tab.scroll = scrollY;
  if (!tab.dirty) tab.draft = tab.raw;

  const host = element("div", "", "editor-host");
  content.replaceChildren(host);
  content.classList.add("editing");
  editor = createEditor(host, tab.draft, {
    cursor: tab.cursor,
    onChange(value) {
      tab.draft = value;
      tab.dirty = value !== tab.raw;
      updateDirty();
      syncTabState();
    },
    onSave: () => void saveDraft(tab),
    onExit: () => void exitEditor(tab),
  });

  setTheme();
  updateDirty();
  syncTabState();
  persistTabs();
}

async function saveDraft(tab: Tab) {
  if (tab !== active || !editor) return;

  const text = editor.view.state.doc.toString();
  const cursor = editor.view.state.selection.main.head;
  tab.draft = text;
  tab.cursor = cursor;

  try {
    await api(`/api/file?path=${encodeURIComponent(tab.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    });
    tab.raw = text;
    tab.dirty = tab.draft !== tab.raw;
    if (tab === active) updateDirty();
    syncTabState();
    persistTabs();
  } catch (error) {
    alert(`No se pudo guardar: ${error instanceof Error ? error.message : String(error)}`);
    if (tab === active) editor?.view.focus();
  }
}

async function exitEditor(tab: Tab) {
  if (tab !== active || !editor) return;

  await saveDraft(tab);
  if (tab !== active || !editor || tab.dirty) return;

  tab.mode = "view";
  leaveEditor();
  persistTabs();
  await showTab(tab, tab.scroll);
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

function pushUrl(url: URL | string) {
  const next = typeof url === "string" ? new URL(url, location.origin) : url;
  if (next.href === location.href) return;
  history.pushState(null, "", next);
}

function replaceUrl(url: URL | string) {
  const next = typeof url === "string" ? new URL(url, location.origin) : url;
  if (next.href === location.href) return;
  history.replaceState(null, "", next);
}

function storeActiveState() {
  if (!active) return;
  if (editor) {
    active.cursor = editor.view.state.selection.main.head;
    active.draft = editor.view.state.doc.toString();
    active.dirty = active.draft !== active.raw;
  } else {
    active.scroll = scrollY;
  }
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

async function showIndex() {
  const id = ++request;
  if (editor) leaveEditor();
  active = null;
  editable = false;
  content.classList.remove("editing");
  crumb.textContent = "";
  updateDirty();
  renderTabs();

  let nodes: Node;
  try {
    const { files } = (await (await api("/api/tree")).json()) as { files: string[] };
    nodes = buildIndex(files);
  } catch (error) {
    nodes = element("p", error instanceof Error ? error.message : String(error), "error");
  }
  if (id !== request) return;

  content.replaceChildren(nodes);
  scrollTo(0, 0);
}

async function showTab(tab: Tab, scroll?: number) {
  const id = ++request;
  if (editor) leaveEditor();
  active = tab;
  editable = false;
  content.classList.remove("editing");
  crumb.textContent = tab.path;
  updateDirty();
  renderTabs();

  if (!tab.loaded) {
    try {
      const source = await loadFile(tab.path);
      if (id !== request) return;
      tab.raw = source;
      if (!tab.dirty) tab.draft = source;
      tab.loaded = true;
      tab.error = undefined;
    } catch (error) {
      if (id !== request) return;
      tab.error = error instanceof Error ? error.message : String(error);
      tab.loaded = false;
    }
  }

  if (id !== request) return;

  if (tab.error) {
    content.replaceChildren(element("p", tab.error, "error"));
    editable = false;
    updateDirty();
    renderTabs();
    return;
  }

  editable = true;
  if (tab.mode === "edit") {
    enterEditor(tab);
    return;
  }

  content.replaceChildren(renderMarkdown(tab.draft, tab.path));
  updateDirty();
  renderTabs();

  if (scroll !== undefined) scrollTo(0, scroll);
  else if (location.hash && currentPath() === tab.path) scrollToHash();
  else scrollTo(0, tab.scroll);
}

function switchTo(tab: Tab, url: URL | string = viewUrl(tab.path)) {
  if (tab === active) {
    if (!tab.loaded) void showTab(tab);
    return;
  }

  storeActiveState();
  if (editor) leaveEditor();
  active = tab;
  pushUrl(url);
  persistTabs();
  renderTabs();
  void showTab(tab);
}

function openInNewTab(path: string, url: URL | string = viewUrl(path)) {
  const tab = ensureTab(path);
  if (tab === active) {
    pushUrl(url);
    if (!tab.loaded) {
      void showTab(tab);
    } else if (!editor && location.hash) {
      scrollToHash();
    }
    return;
  }
  switchTo(tab, url);
}

function openInCurrentTab(path: string, url: URL | string = viewUrl(path)) {
  const existing = findTab(path);
  if (existing) {
    openInNewTab(path, url);
    return;
  }
  if (!active) {
    openInNewTab(path, url);
    return;
  }
  if (
    active.dirty &&
    !confirm("Hay cambios sin guardar. ¿Descartarlos y abrir el archivo en esta pestaña?")
  ) {
    editor?.view.focus();
    return;
  }

  if (editor) leaveEditor();
  resetTab(active);
  active.path = path;
  pushUrl(url);
  persistTabs();
  renderTabs();
  void showTab(active);
}

function switchTab(delta: number) {
  if (tabs.length === 0) return;
  const index = active ? tabs.indexOf(active) : delta > 0 ? -1 : 0;
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next) switchTo(next);
}

function closeTab(tab: Tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;

  const wasActive = tab === active;
  if (wasActive) storeActiveState();
  if (
    tab.dirty &&
    !confirm(`"${tab.path}" tiene cambios sin guardar. ¿Cerrar la pestaña y descartarlos?`)
  ) {
    if (wasActive) editor?.view.focus();
    return;
  }

  if (wasActive && editor) leaveEditor();

  tabs.splice(index, 1);
  persistTabs();

  if (!wasActive) {
    renderTabs();
    return;
  }

  active = null;
  const next = tabs[index] ?? tabs[index - 1];
  if (next) {
    active = next;
    replaceUrl(viewUrl(next.path));
    renderTabs();
    void showTab(next);
  } else {
    replaceUrl(new URL("/", location.origin));
    renderTabs();
    void showIndex();
  }
}

function goIndex() {
  if (currentPath() === null) return;
  storeActiveState();
  if (editor) leaveEditor();
  active = null;
  pushUrl(new URL("/", location.origin));
  persistTabs();
  renderTabs();
  void showIndex();
}

function restoreFromUrl() {
  const path = currentPath();

  if (path === null) {
    storeActiveState();
    if (editor) leaveEditor();
    active = null;
    persistTabs();
    renderTabs();
    void showIndex();
    return;
  }

  const tab = ensureTab(path);
  if (tab === active) {
    if (!tab.loaded) {
      void showTab(tab);
    } else if (!editor) {
      if (location.hash) scrollToHash();
      else scrollTo(0, tab.scroll);
    }
    return;
  }

  storeActiveState();
  if (editor) leaveEditor();
  active = tab;
  persistTabs();
  renderTabs();
  void showTab(tab);
}

const finder = createFinder({
  async list() {
    const response = await api("/api/tree");
    return ((await response.json()) as { files: string[] }).files;
  },
  read: loadFile,
  open(path) {
    openInNewTab(path);
  },
});

const leader = createLeader([
  { keys: ["f"], run: () => finder.open() },
  { keys: ["ArrowLeft"], run: () => switchTab(-1) },
  { keys: ["ArrowRight"], run: () => switchTab(1) },
  {
    keys: ["x"],
    run: () => {
      if (active) closeTab(active);
    },
  },
]);

modeButton.addEventListener("click", () => {
  if (!active) return;
  if (editor) void exitEditor(active);
  else enterEditor(active);
});

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return;

  const url = new URL(link.href);
  if (url.origin !== location.origin) return;

  if (url.pathname === "/") {
    event.preventDefault();
    goIndex();
    return;
  }
  if (!url.pathname.startsWith(VIEW_PREFIX)) return;

  const path = pathFromUrl(url);
  if (!path) return;

  event.preventDefault();
  if (active && active.path === path && !editor) {
    pushUrl(url);
    scrollToHash();
    return;
  }
  if (currentPath() === null) openInNewTab(path, url);
  else openInCurrentTab(path, url);
});

window.addEventListener("popstate", () => {
  restoreFromUrl();
});

window.addEventListener("beforeunload", (event) => {
  if (!tabs.some((tab) => tab.dirty)) return;
  event.preventDefault();
  event.returnValue = "";
});

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement) || !target.isConnected) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (finder.isOpen) return;

  const target = event.target;
  const inEditor = editor?.view.dom.contains(target as Node) ?? false;
  if (inEditor || isTypingTarget(target)) return;

  if (leader.active) {
    event.preventDefault();
    leader.feed(event.key);
    return;
  }

  if (event.key === " ") {
    event.preventDefault();
    leader.start();
    return;
  }

  if (event.key.toLowerCase() === "e" && !editor && editable && active) {
    event.preventDefault();
    enterEditor(active);
  }
});

history.scrollRestoration = "manual";

restoreTabs();
renderTabs();
syncBarHeight();

if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(syncBarHeight).observe(bar);
} else {
  window.addEventListener("resize", syncBarHeight);
}

const initialPath = currentPath();
if (initialPath) {
  const tab = ensureTab(initialPath);
  active = tab;
  persistTabs();
  renderTabs();
  void showTab(tab);
} else {
  void showIndex();
}
