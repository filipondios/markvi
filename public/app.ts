import { createEditor, type EditorExitOptions, type EditorSession } from "./editor.ts";
import { createFinder } from "./finder.ts";
import { createLeader } from "./keys.ts";
import {
  lineAtOffset,
  lineStartOffset,
  lineStarts,
  pickBlockIndex,
  sourceLineAt,
  type BlockBox,
} from "./lines.ts";
import { renderMarkdown, viewUrl, VIEW_PREFIX } from "./render.ts";
import { parseStoredTabs, serializeTabs, type TabMode } from "./tabstore.ts";
import { vimModeLabel, vimStatusText } from "./vimui.ts";

const content = document.querySelector<HTMLElement>("#content")!;
const crumb = document.querySelector<HTMLElement>("#path")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode")!;
const tabBar = document.querySelector<HTMLElement>("#tabs")!;
const bar = document.querySelector<HTMLElement>("#bar")!;
const statusBar = document.querySelector<HTMLElement>("#status")!;
const statusMode = document.querySelector<HTMLElement>("#status-mode")!;
const statusVim = document.querySelector<HTMLElement>("#status-vim")!;
const statusState = document.querySelector<HTMLElement>("#status-state")!;
const statusMessage = document.querySelector<HTMLElement>("#status-message")!;
const statusActions = document.querySelector<HTMLElement>("#status-actions")!;
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
  /** ETag del contenido en disco; detecta cambios externos al guardar. */
  etag?: string;
  /** El archivo cambió o desapareció en disco mientras había cambios locales. */
  conflict?: "changed" | "deleted";
}

interface DiskEvent {
  type: "change" | "delete";
  path: string;
}

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STORAGE_KEY = "markvi:tabs";

const tabs: Tab[] = [];
let active: Tab | null = null;
let request = 0;
let editor: EditorSession | undefined;
let editable = false;
let vimStatusTimer: ReturnType<typeof setInterval> | undefined;

interface BlockEntry extends BlockBox {
  element: HTMLElement;
}

let blockCache: BlockEntry[] | undefined;
let readingElement: HTMLElement | undefined;
let readingFrame = 0;

/** Posición vertical de referencia: 30 % del área visible del contenido. */
function referenceY() {
  const top = bar.getBoundingClientRect().bottom;
  const bottom = statusBar.getBoundingClientRect().top;
  return top + (bottom - top) * 0.3;
}

function blockMap() {
  if (blockCache) return blockCache;

  const map: BlockEntry[] = [];
  for (const element of content.querySelectorAll<HTMLElement>("[data-line]")) {
    const line = Number(element.dataset.line);
    const endLine = Number(element.dataset.endLine ?? element.dataset.line);
    if (!Number.isFinite(line) || !Number.isFinite(endLine)) continue;
    const rect = element.getBoundingClientRect();
    map.push({
      element,
      line,
      endLine,
      top: rect.top + scrollY,
      bottom: rect.bottom + scrollY,
    });
  }
  blockCache = map;
  return map;
}

function invalidateBlocks() {
  blockCache = undefined;
}

function currentBlock() {
  const map = blockMap();
  const index = pickBlockIndex(map, referenceY() + scrollY);
  return index < 0 ? undefined : map[index];
}

/** Línea del archivo que cruza la línea de referencia. Reutilizable. */
function currentSourceLine() {
  return sourceLineAt(blockMap(), referenceY() + scrollY);
}

function updateReadingIndicator() {
  const block = !editor && active && editable ? currentBlock() : undefined;
  if (readingElement === block?.element) return;
  readingElement?.classList.remove("reading");
  readingElement = block?.element;
  readingElement?.classList.add("reading");
}

function scheduleReadingIndicator() {
  if (readingFrame) return;
  readingFrame = requestAnimationFrame(() => {
    readingFrame = 0;
    updateReadingIndicator();
  });
}

/** Desplaza la vista para que `line` quede sobre la línea de referencia. */
function scrollToSourceLine(line: number) {
  const map = blockMap();
  let block: BlockEntry | undefined;
  for (const candidate of map) {
    if (candidate.line <= line && line <= candidate.endLine) block = candidate;
  }
  if (!block) return;

  const span = block.endLine - block.line;
  const ratio = span > 0 ? (line - block.line) / span : 0;
  const y = block.top + (block.bottom - block.top) * ratio;
  scrollTo(0, Math.max(0, y - referenceY()));
}

function cursorForLine(source: string, line: number) {
  const start = lineStartOffset(lineStarts(source), line);
  const end = source.indexOf("\n", start);
  const text = source.slice(start, end < 0 ? source.length : end);
  const offset = text.search(/\S/);
  return offset < 0 ? start : start + offset;
}

function selectedText() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return "";
  if (!content.contains(selection.anchorNode)) return "";
  return selection.toString().trim();
}

function selectionRange() {
  const node = window.getSelection()?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const target = element?.closest<HTMLElement>("[data-line]");
  if (!target || !content.contains(target)) return undefined;
  const line = Number(target.dataset.line);
  const endLine = Number(target.dataset.endLine ?? target.dataset.line);
  return Number.isFinite(line) && Number.isFinite(endLine) ? { line, endLine } : undefined;
}

/** Cursor de entrada al editor: selección si la hay; si no, línea de lectura. */
function readingCursor(tab: Tab) {
  const text = selectedText();
  if (text) {
    const block = selectionRange() ?? currentBlock();
    if (block) {
      const starts = lineStarts(tab.draft);
      const from = lineStartOffset(starts, block.line);
      const to =
        block.endLine >= starts.length
          ? tab.draft.length
          : lineStartOffset(starts, block.endLine + 1);
      const found = tab.draft.slice(from, to).indexOf(text);
      if (found >= 0) return from + found;
    }
  }
  return cursorForLine(tab.draft, currentSourceLine() ?? 1);
}

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
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? `Error ${response.status}`);
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

function syncLayoutMetrics() {
  document.documentElement.style.setProperty("--bar-height", `${bar.offsetHeight}px`);
  document.documentElement.style.setProperty("--status-height", `${statusBar.offsetHeight}px`);
}

type StatusTone = "ok" | "warn" | "error";

interface StatusAction {
  label: string;
  run: () => void;
}

let transient: { message: string; tone: StatusTone } | undefined;
let transientTimer: ReturnType<typeof setTimeout> | undefined;

function notify(message: string, tone: StatusTone = "ok", timeout = 4000) {
  if (transientTimer !== undefined) clearTimeout(transientTimer);
  transient = { message, tone };
  transientTimer =
    timeout > 0
      ? setTimeout(() => {
          transient = undefined;
          transientTimer = undefined;
          renderStatus();
        }, timeout)
      : undefined;
  renderStatus();
}

function statusActionsFor(tab: Tab): StatusAction[] {
  if (tab.conflict === "changed") {
    return [
      { label: "Recargar", run: () => void reloadTab(tab, { discard: true }) },
      { label: "Sobrescribir", run: () => void saveDraft(tab, { force: true }) },
    ];
  }
  if (tab.conflict === "deleted") {
    const actions: StatusAction[] = [
      { label: "Recrear archivo", run: () => void recreateTab(tab) },
    ];
    actions.push(
      tab.dirty
        ? { label: "Descartar cambios", run: () => discardChanges(tab) }
        : { label: "Cerrar pestaña", run: () => closeTab(tab) },
    );
    return actions;
  }
  if (tab.error) {
    return [{ label: "Reintentar", run: () => void showTab(tab) }];
  }
  return [];
}

function renderStatusActions(actions: StatusAction[]) {
  statusActions.replaceChildren(
    ...actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        action.run();
        editor?.view.focus();
      });
      return button;
    }),
  );
}

function paintVimStatus() {
  if (!editor) {
    statusVim.textContent = "";
    return;
  }

  const status = editor.vimStatus();
  statusMode.textContent = vimModeLabel(status.mode);
  statusVim.textContent = vimStatusText(status);
}

function renderStatus() {
  const tab = active;
  statusMode.textContent = tab ? (editor ? vimModeLabel(editor.vimStatus().mode) : "Vista") : "Índice";
  statusVim.textContent = editor ? vimStatusText(editor.vimStatus()) : "";

  let state = "Listo";
  let tone: StatusTone = "ok";
  let message = "";

  if (tab) {
    if (tab.conflict === "changed") {
      state = "Conflicto";
      tone = "warn";
      message = "El archivo cambió en disco.";
    } else if (tab.conflict === "deleted") {
      state = "Archivo borrado";
      tone = "error";
      message = "El archivo ya no existe.";
    } else if (tab.error) {
      state = "Error";
      tone = "error";
      message = tab.error;
    } else if (tab.dirty) {
      state = "Sin guardar";
      tone = "warn";
    } else {
      state = "Guardado";
    }
  }

  if (transient) {
    message = transient.message;
    tone = transient.tone;
  }

  statusState.textContent = state;
  statusState.dataset.tone = tone;
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
  statusMessage.title = message;

  renderStatusActions(tab ? statusActionsFor(tab) : []);
}

function renderTabs() {
  tabBar.hidden = tabs.length === 0;
  const fragment = document.createDocumentFragment();

  for (const tab of tabs) {
    const item = element("div", "", "tab");
    item.dataset.path = tab.path;
    item.classList.toggle("is-active", tab === active);
    item.classList.toggle("is-dirty", tab.dirty);
    item.classList.toggle("is-conflict", !!tab.conflict);

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
  syncLayoutMetrics();
}

function syncTabState() {
  for (const item of tabBar.querySelectorAll<HTMLElement>(".tab")) {
    const tab = item.dataset.path ? findTab(item.dataset.path) : undefined;
    if (!tab) continue;
    item.classList.toggle("is-active", tab === active);
    item.classList.toggle("is-dirty", tab.dirty);
    item.classList.toggle("is-conflict", !!tab.conflict);
    item.querySelector(".tab-link")?.setAttribute("aria-selected", String(tab === active));
  }
}

function updateChrome() {
  const tab = active;
  const editing = !!editor;
  modeButton.textContent = editing ? "Vim" : "Editar";
  modeButton.setAttribute("aria-pressed", String(editing));
  modeButton.setAttribute(
    "aria-label",
    editing ? "Editor Vim: :wq guarda y sale" : "Editar (a)",
  );
  modeButton.title = editing ? "Editor Vim: :wq guarda y sale" : "Editar (a)";
  modeButton.disabled = editing || !tab || !editable;

  document.title = tab ? `${tab.dirty ? "● " : ""}${tab.path} · markvi` : "markvi";
  renderStatus();
}

function setTheme() {
  editor?.setDark(themePreference.matches);
}

themePreference.addEventListener("change", setTheme);

function leaveEditor() {
  if (vimStatusTimer !== undefined) {
    clearInterval(vimStatusTimer);
    vimStatusTimer = undefined;
  }
  statusVim.textContent = "";
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
  // Desde la vista manda la posición de lectura (o la selección), no el cursor
  // guardado de la última edición.
  const cursor = wasView ? readingCursor(tab) : tab.cursor;
  const screenY = wasView ? referenceY() : undefined;

  tab.mode = "edit";
  if (wasView) tab.scroll = scrollY;
  if (!tab.dirty) tab.draft = tab.raw;
  tab.cursor = cursor;

  const host = element("div", "", "editor-host");
  content.replaceChildren(host);
  content.classList.add("editing");
  invalidateBlocks();
  editor = createEditor(host, tab.draft, {
    cursor,
    screenY,
    onChange(value) {
      tab.draft = value;
      tab.dirty = value !== tab.raw;
      updateChrome();
      syncTabState();
    },
    onSave: () => saveDraft(tab),
    onExit: (options) => exitEditor(tab, options),
    onMessage: (message) => notify(message, "warn", 0),
    hasChanges: () => tab.dirty,
  });

  updateReadingIndicator();
  setTheme();
  updateChrome();
  syncTabState();
  persistTabs();
  vimStatusTimer = setInterval(paintVimStatus, 100);
}

async function saveDraft(tab: Tab, options: { force?: boolean } = {}) {
  if (tab !== active || !editor) return false;

  const text = editor.view.state.doc.toString();
  tab.draft = text;
  tab.cursor = editor.view.state.selection.main.head;

  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
  if (tab.etag && !options.force) headers["If-Match"] = tab.etag;

  try {
    const response = await api(`/api/file?path=${encodeURIComponent(tab.path)}`, {
      method: "PUT",
      headers,
      body: text,
    });

    tab.raw = text;
    tab.dirty = false;
    tab.etag = response.headers.get("etag") ?? undefined;
    tab.conflict = undefined;
    tab.loaded = true;
    tab.error = undefined;

    updateChrome();
    syncTabState();
    persistTabs();
    notify("Guardado en disco", "ok", 2500);
    return true;
  } catch (error) {
    handleSaveError(tab, error);
    return false;
  }
}

// Escribe el contenido actual aunque el archivo ya no exista en disco.
async function recreateTab(tab: Tab) {
  const text = tab === active && editor ? editor.view.state.doc.toString() : tab.draft;

  try {
    const response = await api(`/api/file?path=${encodeURIComponent(tab.path)}&create=1`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    });

    tab.raw = text;
    tab.draft = text;
    tab.dirty = false;
    tab.loaded = true;
    tab.error = undefined;
    tab.conflict = undefined;
    tab.etag = response.headers.get("etag") ?? undefined;

    if (tab === active) {
      if (editor) {
        editor.setDoc(text);
      } else {
        editable = true;
        content.replaceChildren(renderMarkdown(tab.draft, tab.path));
        invalidateBlocks();
        updateReadingIndicator();
      }
      updateChrome();
      renderTabs();
    } else {
      syncTabState();
    }

    persistTabs();
    notify("Archivo recreado", "ok", 2500);
    return true;
  } catch (error) {
    handleSaveError(tab, error);
    return false;
  }
}

function handleSaveError(tab: Tab, error: unknown) {
  const status = error instanceof ApiError ? error.status : 0;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 409) {
    tab.conflict = "changed";
    notify("El archivo cambió en disco: recarga o sobrescribe.", "warn", 0);
  } else if (status === 404) {
    tab.conflict = "deleted";
    tab.etag = undefined;
    notify("El archivo ya no existe: puedes recrearlo con tus cambios.", "error", 0);
  } else if (status === 403) {
    notify(message, "error", 0);
  } else {
    notify(`No se pudo guardar: ${message}`, "error", 0);
  }

  if (tab === active) editor?.view.focus();
  updateChrome();
  syncTabState();
}

async function reloadTab(tab: Tab, options: { discard?: boolean } = {}) {
  if (tab.dirty && !options.discard) return false;

  // Si la pestaña activa tenía una carga en curso, esta recarga manda: se
  // invalida la petición anterior para que no pinte contenido viejo al llegar.
  const id = tab === active ? ++request : undefined;

  try {
    const file = await loadFile(tab.path);
    if (id !== undefined && id !== request) return false;

    tab.raw = file.text;
    tab.draft = file.text;
    tab.etag = file.etag;
    tab.dirty = false;
    tab.loaded = true;
    tab.error = undefined;
    tab.conflict = undefined;

    if (tab === active) {
      if (editor) {
        editor.setDoc(tab.draft);
      } else {
        editable = true;
        const scroll = scrollY;
        content.replaceChildren(renderMarkdown(tab.draft, tab.path));
        scrollTo(0, scroll);
        invalidateBlocks();
        updateReadingIndicator();
      }
      updateChrome();
      renderTabs();
    } else {
      syncTabState();
    }

    persistTabs();
    notify(
      options.discard ? "Cambios descartados y archivo recargado" : "Recargado desde disco",
      "ok",
      2500,
    );
    return true;
  } catch (error) {
    const missing = error instanceof ApiError && error.status === 404;
    const message = error instanceof Error ? error.message : String(error);
    tab.etag = undefined;

    if (missing) {
      tab.conflict = "deleted";
      if (!tab.dirty) {
        tab.loaded = false;
        tab.error = "Archivo no encontrado.";
        if (tab === active && !editor) {
          content.replaceChildren(element("p", tab.error, "error"));
          editable = false;
        }
      }
      if (tab === active) notify("El archivo se borró en disco.", "error", 0);
    } else if (tab === active) {
      notify(`No se pudo recargar: ${message}`, "error", 0);
    }

    updateChrome();
    syncTabState();
    return false;
  }
}

function discardChanges(tab: Tab) {
  const wasDeleted = tab.conflict === "deleted";
  if (tab === active && editor) leaveEditor();

  tab.mode = "view";
  tab.draft = tab.raw;
  tab.dirty = false;
  tab.conflict = undefined;

  if (wasDeleted) {
    tab.loaded = false;
    tab.etag = undefined;
    tab.error = "Archivo no encontrado.";
  }

  if (tab === active) {
    editable = !wasDeleted;
    if (wasDeleted) content.replaceChildren(element("p", tab.error!, "error"));
    else content.replaceChildren(renderMarkdown(tab.draft, tab.path));
    invalidateBlocks();
    updateReadingIndicator();
    updateChrome();
    renderTabs();
  } else {
    syncTabState();
  }

  persistTabs();
  notify("Cambios descartados", "ok", 2500);
}

async function exitEditor(tab: Tab, options: EditorExitOptions = {}) {
  if (tab !== active || !editor) return;

  if (options.save) {
    const saved = await saveDraft(tab);
    if (!saved || tab !== active || !editor) return;
  }

  tab.mode = "view";
  leaveEditor();

  if (options.discard) {
    const hadChanges = tab.dirty;
    tab.draft = tab.raw;
    tab.dirty = false;
    if (hadChanges) notify("Cambios descartados", "ok", 2500);
    if (tab.conflict) {
      persistTabs();
      await reloadTab(tab, { discard: true });
      return;
    }
  }

  persistTabs();
  const line = lineAtOffset(lineStarts(tab.draft), Math.min(tab.cursor, tab.draft.length));
  await showTab(tab);
  scrollToSourceLine(line);
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
  return { text: await response.text(), etag: response.headers.get("etag") ?? undefined };
}

async function readText(path: string) {
  return (await loadFile(path)).text;
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
  updateChrome();
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
  invalidateBlocks();
  updateReadingIndicator();
}

async function showTab(tab: Tab, scroll?: number) {
  const id = ++request;
  if (editor) leaveEditor();
  active = tab;
  editable = false;
  content.classList.remove("editing");
  crumb.textContent = tab.path;
  updateChrome();
  renderTabs();

  if (!tab.loaded) {
    try {
      const file = await loadFile(tab.path);
      if (id !== request) return;
      tab.raw = file.text;
      tab.etag = file.etag;
      if (!tab.dirty) tab.draft = file.text;
      tab.loaded = true;
      tab.error = undefined;
      tab.conflict = undefined;
    } catch (error) {
      if (id !== request) return;
      tab.error = error instanceof Error ? error.message : String(error);
      tab.loaded = false;
      tab.etag = undefined;
      if (error instanceof ApiError && error.status === 404) tab.conflict = "deleted";
    }
  }

  if (id !== request) return;

  if (tab.error) {
    content.replaceChildren(element("p", tab.error, "error"));
    editable = false;
    invalidateBlocks();
    updateReadingIndicator();
    updateChrome();
    renderTabs();
    return;
  }

  editable = true;
  if (tab.mode === "edit") {
    enterEditor(tab);
    return;
  }

  content.replaceChildren(renderMarkdown(tab.draft, tab.path));
  updateChrome();
  renderTabs();

  if (scroll !== undefined) scrollTo(0, scroll);
  else if (location.hash && currentPath() === tab.path) scrollToHash();
  else scrollTo(0, tab.scroll);
  invalidateBlocks();
  updateReadingIndicator();
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

let indexRefreshTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIndexRefresh() {
  if (indexRefreshTimer !== undefined) return;
  indexRefreshTimer = setTimeout(() => {
    indexRefreshTimer = undefined;
    void refreshIndex();
  }, 200);
}

async function refreshIndex() {
  if (active) return;

  try {
    const { files } = (await (await api("/api/tree")).json()) as { files: string[] };
    const shown = [...content.querySelectorAll<HTMLAnchorElement>(".files a")].map(
      (link) => link.textContent ?? "",
    );
    if (shown.length === files.length && shown.every((file, index) => file === files[index])) {
      return;
    }

    const scroll = scrollY;
    content.replaceChildren(buildIndex(files));
    scrollTo(0, scroll);
    invalidateBlocks();
    updateReadingIndicator();
    notify("Índice actualizado", "ok", 2000);
  } catch {
    // Si el árbol falla se mantiene el índice anterior.
  }
}

async function handleDiskChange(event: DiskEvent) {
  if (!active) scheduleIndexRefresh();

  const affected = tabs.filter(
    (tab) => tab.path === event.path && (tab.loaded || tab === active),
  );

  for (const tab of affected) {
    if (tab.dirty) {
      // Un evento puede ser solo un cambio de permisos o de fecha: se compara
      // el contenido con el último guardado antes de declarar un conflicto.
      let type = event.type;
      if (type === "change") {
        const current = await loadFile(tab.path).catch(() => null);
        if (current) {
          // El evento puede venir de nuestro propio guardado en curso: si el
          // disco ya tiene el borrador actual, no hay conflicto.
          if (current.text === tab.raw || current.text === tab.draft) continue;
        } else {
          type = "delete";
        }
      }

      tab.conflict = type === "delete" ? "deleted" : "changed";
      if (type === "delete") tab.etag = undefined;
      if (tab === active) {
        notify(
          type === "delete"
            ? "El archivo se borró en disco. Tienes cambios sin guardar."
            : "El archivo cambió en disco. Tienes cambios sin guardar.",
          "warn",
          0,
        );
        updateChrome();
      }
      syncTabState();
      continue;
    }

    await reloadTab(tab);
  }
}

function connectEvents() {
  const source = new EventSource("/api/events");

  // Al conectar (o reconectar) se revisa el índice: puede haberse perdido algún
  // evento entre la carga inicial y la apertura del flujo.
  source.addEventListener("open", () => {
    if (!active) void refreshIndex();
  });

  source.addEventListener("message", (message) => {
    let event: unknown;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;

    const { type, path } = event as { type?: unknown; path?: unknown };
    if ((type !== "change" && type !== "delete") || typeof path !== "string") return;
    void handleDiskChange({ type, path });
  });
}

const finder = createFinder({
  async list() {
    const response = await api("/api/tree");
    return ((await response.json()) as { files: string[] }).files;
  },
  read: readText,
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
  if (active && !editor) enterEditor(active);
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

// La líder también funciona en modo Normal del editor. Se intercepta en
// captura para que Vim no reciba el espacio ni las teclas de la secuencia.
document.addEventListener(
  "keydown",
  (event) => {
    if (!editor || event.isComposing) return;

    const target = event.target;
    if (!(target instanceof Node) || !editor.view.dom.contains(target)) return;
    if (target instanceof Element && target.closest(".cm-vim-panel")) return;

    if (leader.active) {
      event.preventDefault();
      event.stopPropagation();
      leader.feed(event.key);
      return;
    }

    if (event.key === " " && editor.vimStatus().mode === "normal") {
      event.preventDefault();
      event.stopPropagation();
      leader.start();
    }
  },
  true,
);

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

  const key = event.key.toLowerCase();
  if ((key === "a" || key === "i") && !editor && editable && active) {
    event.preventDefault();
    enterEditor(active);
  }
});

history.scrollRestoration = "manual";

restoreTabs();
renderTabs();
syncLayoutMetrics();
connectEvents();

const relayout = () => {
  invalidateBlocks();
  syncLayoutMetrics();
  scheduleReadingIndicator();
};

window.addEventListener("scroll", scheduleReadingIndicator, { passive: true });
window.addEventListener("resize", relayout);

if (typeof ResizeObserver !== "undefined") {
  const observer = new ResizeObserver(relayout);
  observer.observe(bar);
  observer.observe(statusBar);
  observer.observe(content);
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
