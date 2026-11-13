import {
  applyVimMappings,
  createEditor,
  setEditorDefaults,
  type EditorExitOptions,
  type EditorSession,
  type FileCommand,
} from "./editor.ts";
import { createBacklinks } from "./backlinks.ts";
import { createFinder } from "./finder.ts";
import { fuzzySearch } from "./fuzzy.ts";
import { applyAppearance, isDark, keyLabel, loadClientConfig } from "./config.ts";
import { createGrep } from "./grep.ts";
import { hintLabels } from "./hints.ts";
import { createLeader, isModifierKey } from "./keys.ts";
import {
  interpolateLine,
  lineAtOffset,
  lineStartOffset,
  lineStarts,
  pickBlockIndex,
  readingBlockIndex,
  readingReferenceY,
  type BlockBox,
} from "./lines.ts";
import { normalizeNewPath } from "./newfile.ts";
import {
  alternatePath,
  parseRecent,
  recentChoices,
  recordVisit,
  removeRecent,
  renameRecent,
  serializeRecent,
} from "./recent.ts";
import {
  refreshWikiLinks,
  renderMarkdown,
  setRenderOptions,
  setWikiFiles,
  viewUrl,
  VIEW_PREFIX,
} from "./render.ts";
import { createReadingCursor } from "./readingcursor.ts";
import { buildTextMap, isCaseSensitive, matchOffsets, rangeFor } from "./search.ts";
import { createSelector, highlight } from "./selector.ts";
import { parseStoredTabs, serializeTabs, tabLabels, type TabMode } from "./tabstore.ts";
import { toggleTask } from "./tasks.ts";
import { extractHeadings, type Heading } from "./toc.ts";
import { createViewNav, type ViewCommand } from "./viewnav.ts";
import { vimModeLabel, vimStatusText } from "./vimui.ts";

const content = document.querySelector<HTMLElement>("#content")!;
const tabBar = document.querySelector<HTMLElement>("#tabs")!;
const bar = document.querySelector<HTMLElement>("#bar")!;
const statusBar = document.querySelector<HTMLElement>("#status")!;
const statusMode = document.querySelector<HTMLElement>("#status-mode")!;
const statusPath = document.querySelector<HTMLElement>("#status-path")!;
const statusDirty = document.querySelector<HTMLElement>("#status-dirty")!;
const statusVim = document.querySelector<HTMLElement>("#status-vim")!;
const statusState = document.querySelector<HTMLElement>("#status-state")!;
const statusMessage = document.querySelector<HTMLElement>("#status-message")!;
const statusTasks = document.querySelector<HTMLElement>("#status-tasks")!;
const statusPosition = document.querySelector<HTMLElement>("#status-position")!;
const statusActions = document.querySelector<HTMLElement>("#status-actions")!;
const promptBar = document.querySelector<HTMLElement>("#prompt")!;
const promptPrefix = document.querySelector<HTMLElement>("#prompt-prefix")!;
const promptInput = document.querySelector<HTMLInputElement>("#prompt-input")!;
const themePreference = matchMedia("(prefers-color-scheme: dark)");

// Configuración del usuario (~/.config/markvi/config.toml). Se aplica antes de
// crear nada: tema, fuente, opciones y mapeos del editor.
const loadedConfig = await loadClientConfig();
const config = loadedConfig.config;
const configWarnings = [...loadedConfig.warnings];
applyAppearance(config);
setEditorDefaults(config.editor);
setRenderOptions(config.render);
configWarnings.push(...applyVimMappings(config.vimMappings));

/** ¿Es esta la tecla líder? (AltGr cuenta como Ctrl+Alt: no se descarta.) */
function isLeaderKey(event: KeyboardEvent) {
  if (event.key !== config.leader || event.metaKey) return false;
  return !event.ctrlKey || event.altKey;
}

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
const RECENT_KEY = "markvi:recent";

// Archivos visitados, el más reciente primero (para `space + r` y `Ctrl-^`).
let recent = loadRecent();
// Casillas de la vista renderizada: marcadas / total.
let taskCounts = { done: 0, total: 0 };

const tabs: Tab[] = [];
let active: Tab | null = null;
let request = 0;
let editor: EditorSession | undefined;
let editable = false;
let loading = false;
let vimStatusTimer: ReturnType<typeof setInterval> | undefined;

interface BlockEntry extends BlockBox {
  element: HTMLElement;
}

interface SearchState {
  query: string;
  matches: Range[];
  index: number;
}

interface HintEntry {
  label: string;
  link: HTMLAnchorElement;
  span: HTMLElement;
}

interface HintState {
  entries: HintEntry[];
  typed: string;
  overlay: HTMLElement;
}

let blockCache: BlockEntry[] | undefined;
let navigationCache: BlockEntry[] | undefined;
let readingElement: HTMLElement | undefined;
// Bloque marcado a restaurar tras un relayout (imágenes, resize) para que el
// cursor explícito no salte a la referencia geométrica.
let keptCursorElement: HTMLElement | undefined;
const readingCursorState = createReadingCursor();
let programmaticScrollTarget: number | undefined;
const readingMarker = document.createElement("span");
readingMarker.className = "reading-marker";
readingMarker.textContent = "▸";
readingMarker.setAttribute("aria-hidden", "true");
document.body.append(readingMarker);
let readingFrame = 0;

const viewNav = createViewNav();
let searchState: SearchState | undefined;
let hints: HintState | undefined;
let promptMode: "search" | "ex" | undefined;
let promptDirection: 1 | -1 = 1;

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
  keptCursorElement =
    readingCursorState.index !== undefined && readingElement?.isConnected
      ? readingElement
      : undefined;
  blockCache = undefined;
  navigationCache = undefined;
  readingCursorState.clear();
  if (!readingElement?.isConnected) readingElement = undefined;
}

function readingBlocks() {
  return navigationBlocks();
}

function currentNavigationIndex() {
  const blocks = readingBlocks();
  if (keptCursorElement) {
    const kept = blocks.findIndex((block) => block.element === keptCursorElement);
    keptCursorElement = undefined;
    if (kept >= 0) readingCursorState.set(kept, blocks.length);
  }
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const readingY = readingReferenceY(
    referenceY() + scrollY,
    statusBar.getBoundingClientRect().top + scrollY,
    scrollY,
    maxScroll,
  );
  const index = readingCursorState.current(blocks, readingY, scrollY, maxScroll);
  return { blocks, index };
}

function currentBlock() {
  const { blocks, index } = currentNavigationIndex();
  return index < 0 ? undefined : blocks[index];
}

/** Línea fuente del bloque que el cursor de lectura mantiene seleccionado. */
function currentSourceLine() {
  const block = currentBlock();
  if (!block) return undefined;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const y = readingReferenceY(
    referenceY() + scrollY,
    statusBar.getBoundingClientRect().top + scrollY,
    scrollY,
    maxScroll,
  );
  // Dentro del bloque se interpola; si el cursor se movió a un bloque que la
  // referencia no toca (scroll topado, clic), la línea es la de inicio del bloque.
  return y >= block.top && y <= block.bottom ? interpolateLine(block, y) : block.line;
}

/** Bloque bajo un punto de la página; si el punto cae en un hueco, el anterior. */
function blockAtPoint(clientY: number) {
  const map = blockMap();
  const index = pickBlockIndex(map, clientY + scrollY);
  return index < 0 ? undefined : map[index];
}

/** Línea del archivo bajo un punto de la página, interpolada dentro del bloque. */
function lineAtPoint(target: Element | null, clientY: number) {
  const y = clientY + scrollY;
  const element = target?.closest<HTMLElement>("[data-line]");
  if (element && content.contains(element)) {
    const line = Number(element.dataset.line);
    const endLine = Number(element.dataset.endLine ?? element.dataset.line);
    if (Number.isFinite(line) && Number.isFinite(endLine)) {
      const rect = element.getBoundingClientRect();
      return interpolateLine(
        { line, endLine, top: rect.top + scrollY, bottom: rect.bottom + scrollY },
        y,
      );
    }
  }
  const block = blockAtPoint(clientY);
  return block ? interpolateLine(block, y) : undefined;
}

function updateReadingIndicator() {
  const block = !editor && active && editable ? currentBlock() : undefined;
  if (readingElement !== block?.element) {
    readingElement?.classList.remove("reading");
    readingElement = block?.element;
    readingElement?.classList.add("reading");
  }

  if (!block) {
    readingMarker.hidden = true;
    return;
  }

  const contentRect = content.getBoundingClientRect();
  const blockRect = block.element.getBoundingClientRect();
  const viewTop = bar.getBoundingClientRect().bottom + 2;
  const viewBottom = statusBar.getBoundingClientRect().top - 2;
  const style = getComputedStyle(block.element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const fontSize = Number.parseFloat(style.fontSize);
  const firstLineHeight = Number.isFinite(lineHeight)
    ? lineHeight
    : Number.isFinite(fontSize)
      ? fontSize * 1.65
      : 24;
  // Primera línea de texto: el bloque puede llevar borde/relleno superior (código, citas).
  const inset =
    (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.borderTopWidth) || 0);
  const lineTop = blockRect.top + inset;
  const targetY = lineTop < viewTop ? viewTop : Math.min(lineTop, viewBottom - firstLineHeight);
  const y = targetY + Math.max(0, (firstLineHeight - 18) / 2);

  // Sin suavizado propio: la transición CSS de 120 ms desliza el marcador y llega
  // siempre al destino. Al aparecer por primera vez se coloca sin animar.
  const wasHidden = readingMarker.hidden;
  readingMarker.hidden = false;
  if (wasHidden) readingMarker.style.transition = "none";
  readingMarker.style.left = `${contentRect.left + 1}px`;
  readingMarker.style.transform = `translateY(${y}px)`;
  if (wasHidden) {
    void readingMarker.offsetWidth;
    readingMarker.style.transition = "";
  }
}

function scheduleReadingIndicator() {
  if (readingFrame) return;
  readingFrame = requestAnimationFrame(() => {
    readingFrame = 0;
    updateReadingIndicator();
    updateStatusPosition();
  });
}

function sourceBlockIndex(line: number, blocks = navigationBlocks()) {
  let index = -1;
  blocks.forEach((block, position) => {
    if (block.line <= line && line <= block.endLine) index = position;
  });
  return index;
}

/** Desplaza la vista para que `line` quede sobre la línea de referencia. */
function scrollToSourceLine(line: number) {
  const blocks = navigationBlocks();
  const index = sourceBlockIndex(line, blocks);
  const block = blocks[index];
  if (!block) return;

  const span = block.endLine - block.line;
  const ratio = span > 0 ? (line - block.line) / span : 0;
  const y = block.top + (block.bottom - block.top) * ratio;
  readingCursorState.set(index, blocks.length);
  const rect = block.element.getBoundingClientRect();
  const visibleTop = bar.getBoundingClientRect().bottom + 8;
  const visibleBottom = statusBar.getBoundingClientRect().top - 8;
  let delta = y - referenceY();
  if (rect.height <= visibleBottom - visibleTop) {
    if (rect.top < visibleTop) delta = rect.top - visibleTop;
    else if (rect.bottom > visibleBottom) delta = rect.bottom - visibleBottom;
    else delta = 0;
  }
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const target = Math.min(maxScroll, Math.max(0, scrollY + delta));
  if (Math.abs(scrollY - target) > 1) {
    programmaticScrollTarget = target;
    scrollTo(0, target);
    setTimeout(() => {
      if (programmaticScrollTarget === target) programmaticScrollTarget = undefined;
    }, 100);
  }
  scheduleReadingIndicator();
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

/** Bloques navegables: se colapsan los que comparten altura (lista y su primer
 * elemento) para que `j`/`k` avancen de verdad. */
// Se llama en cada evento de scroll y en cada fotograma del indicador: se reutiliza
// mientras no se invalide el mapa de bloques (antes se reconstruía en O(N) cada vez).
function navigationBlocks() {
  const map = blockMap();
  if (navigationCache) return navigationCache;
  const blocks: BlockEntry[] = [];
  for (const block of map) {
    const last = blocks[blocks.length - 1];
    if (last && Math.abs(last.top - block.top) < 1) blocks[blocks.length - 1] = block;
    else blocks.push(block);
  }
  navigationCache = blocks;
  return blocks;
}

function scrollToBlock(index: number) {
  const blocks = navigationBlocks();
  const block = blocks[index];
  if (!block) return;
  readingCursorState.set(index, blocks.length);

  const rect = block.element.getBoundingClientRect();
  const visibleTop = bar.getBoundingClientRect().bottom + 8;
  const visibleBottom = statusBar.getBoundingClientRect().top - 8;
  const visibleHeight = visibleBottom - visibleTop;
  let delta = 0;
  if (rect.height > visibleHeight || rect.top < visibleTop) delta = rect.top - visibleTop;
  else if (rect.bottom > visibleBottom) delta = rect.bottom - visibleBottom;

  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const target = Math.min(maxScroll, Math.max(0, scrollY + delta));
  if (Math.abs(scrollY - target) > 1) {
    programmaticScrollTarget = target;
    scrollTo(0, target);
    setTimeout(() => {
      if (programmaticScrollTarget === target) programmaticScrollTarget = undefined;
    }, 100);
  }
  scheduleReadingIndicator();
}

function moveBlock(delta: number) {
  const { blocks, index } = currentNavigationIndex();
  if (blocks.length === 0) return;
  const next = readingCursorState.set(index + delta, blocks.length);
  scrollToBlock(next);
}

function goTop(count?: number) {
  const blocks = navigationBlocks();
  if (count === undefined) {
    scrollToBlock(0);
    return;
  }
  const index = Math.min(blocks.length, Math.max(1, count)) - 1;
  scrollToBlock(index);
}

function goBottom(count?: number) {
  const blocks = navigationBlocks();
  if (count === undefined) {
    scrollToBlock(blocks.length - 1);
    return;
  }
  const index = Math.min(blocks.length, Math.max(1, count)) - 1;
  scrollToBlock(index);
}

/** Ctrl-d / Ctrl-u: media página de scroll y el cursor avanza lo mismo, como en
 * Vim; con el scroll topado el cursor sigue moviéndose. */
function halfPage(direction: 1 | -1) {
  const top = bar.getBoundingClientRect().bottom;
  const bottom = statusBar.getBoundingClientRect().top;
  const half = (bottom - top) / 2;
  const blocks = navigationBlocks();
  const { index } = currentNavigationIndex();
  if (index < 0) return;

  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const targetY = Math.min(maxScroll, Math.max(0, scrollY + direction * half));
  const wanted = pickBlockIndex(blocks, blocks[index]!.top + direction * half);
  const next = Math.min(
    blocks.length - 1,
    Math.max(0, direction > 0 ? Math.max(wanted, index + 1) : Math.min(wanted, index - 1)),
  );
  readingCursorState.set(next, blocks.length);

  if (Math.abs(scrollY - targetY) > 1) {
    programmaticScrollTarget = targetY;
    scrollTo(0, targetY);
    setTimeout(() => {
      if (programmaticScrollTarget === targetY) programmaticScrollTarget = undefined;
    }, 100);
  }
  scheduleReadingIndicator();
}

function headingElements() {
  return Array.from(content.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
}

function currentHeadingLine() {
  const block = currentBlock();
  if (!block) return 1;
  let line = 1;
  for (const heading of headingElements()) {
    const headingLine = Number(heading.dataset.line);
    if (Number.isFinite(headingLine) && headingLine <= block.endLine) line = headingLine;
  }
  return line;
}

function moveHeading(direction: 1 | -1, count: number) {
  const headings = headingElements();
  if (headings.length === 0) {
    notify("The document has no headings", "warn", 2000);
    return;
  }

  const currentLine = currentSourceLine() ?? 1;
  let headingIndex = -1;
  headings.forEach((heading, position) => {
    if (Number(heading.dataset.line) <= currentLine) headingIndex = position;
  });
  const next = Math.min(headings.length - 1, Math.max(0, headingIndex + direction * count));
  const headingLine = Number(headings[next]!.dataset.line);
  scrollToSourceLine(headingLine);
}

function switchTabBy(direction: 1 | -1, count?: number) {
  if (tabs.length === 0) return;

  if (count === undefined) {
    switchTab(direction);
    return;
  }

  if (direction > 0) {
    const tab = tabs[Math.min(tabs.length, Math.max(1, count)) - 1];
    if (tab) switchTo(tab);
    return;
  }

  const index = active ? tabs.indexOf(active) : 0;
  const target = ((index - count) % tabs.length + tabs.length) % tabs.length;
  const tab = tabs[target];
  if (tab) switchTo(tab);
}

function goHistory(direction: 1 | -1) {
  if (direction < 0) history.back();
  else history.forward();
}

const supportsHighlights =
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

function clearSearch() {
  searchState = undefined;
  if (!supportsHighlights) return;
  CSS.highlights.delete("markvi-search");
  CSS.highlights.delete("markvi-search-current");
}

function paintSearch() {
  if (!supportsHighlights) return;
  if (!searchState) {
    CSS.highlights.delete("markvi-search");
    CSS.highlights.delete("markvi-search-current");
    return;
  }
  CSS.highlights.set("markvi-search", new Highlight(...searchState.matches));
  CSS.highlights.set(
    "markvi-search-current",
    new Highlight(searchState.matches[searchState.index]!),
  );
}

function scrollToMatch(range: Range) {
  const rect = range.getBoundingClientRect();
  const node = range.startContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const source = element?.closest<HTMLElement>("[data-line]");
  if (source) {
    const blocks = navigationBlocks();
    let blockIndex = -1;
    for (const [index, block] of blocks.entries()) {
      if (block.element.contains(source)) blockIndex = index;
    }
    if (blockIndex >= 0) readingCursorState.set(blockIndex, blocks.length);
  }
  const target = Math.max(0, rect.top + scrollY - referenceY());
  programmaticScrollTarget = target;
  scrollTo(0, target);
  setTimeout(() => {
    if (programmaticScrollTarget === target) programmaticScrollTarget = undefined;
  }, 100);
  scheduleReadingIndicator();
}

function searchDocument(query: string, direction: 1 | -1) {
  clearSearch();

  const { text, spans } = buildTextMap(content);
  const caseSensitive = isCaseSensitive(query);
  const matches: Range[] = [];

  for (const offset of matchOffsets(text, query, caseSensitive)) {
    const range = rangeFor(spans, offset.start, offset.end);
    if (range) matches.push(range);
  }

  if (matches.length === 0) {
    notify(`No matches: ${query}`, "warn", 2500);
    return;
  }

  const y = referenceY() + scrollY;
  let index: number;
  if (direction > 0) {
    index = matches.findIndex((range) => range.getBoundingClientRect().top + scrollY >= y);
    if (index < 0) index = 0;
  } else {
    index = -1;
    for (let position = matches.length - 1; position >= 0; position--) {
      if (matches[position]!.getBoundingClientRect().top + scrollY < y) {
        index = position;
        break;
      }
    }
    if (index < 0) index = matches.length - 1;
  }

  searchState = { query, matches, index };
  paintSearch();
  scrollToMatch(matches[index]!);
  notify(
    `${matches.length} match${matches.length === 1 ? "" : "es"}: ${query}`,
    "ok",
    2500,
  );
}

function nextMatch(direction: 1 | -1, count: number) {
  if (!searchState) {
    notify("No active search", "warn", 2000);
    return;
  }
  const total = searchState.matches.length;
  searchState.index = ((searchState.index + direction * count) % total + total) % total;
  paintSearch();
  scrollToMatch(searchState.matches[searchState.index]!);
}

function openHints() {
  if (hints) return;

  const barBottom = bar.getBoundingClientRect().bottom;
  const statusTop = statusBar.getBoundingClientRect().top;
  const links = Array.from(content.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(
    (link) => {
      const rect = link.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > barBottom && rect.top < statusTop;
    },
  );

  if (links.length === 0) {
    notify("No visible links", "warn", 2000);
    return;
  }

  const labels = hintLabels(links.length);
  const overlay = element("div", "", "hint-layer");
  const entries = links.slice(0, labels.length).map((link, index) => {
    const label = labels[index]!;
    const rect = link.getBoundingClientRect();
    const span = element("span", label, "hint");
    span.style.left = `${rect.left}px`;
    span.style.top = `${rect.top}px`;
    overlay.append(span);
    return { label, link, span };
  });

  document.body.append(overlay);
  hints = { entries, typed: "", overlay };
  paintHints();
}

function paintHints() {
  if (!hints) return;
  for (const entry of hints.entries) {
    const visible = entry.label.startsWith(hints.typed);
    entry.span.hidden = !visible;
    entry.span.textContent = entry.label.slice(hints.typed.length);
  }
}

function closeHints() {
  if (!hints) return;
  hints.overlay.remove();
  hints = undefined;
}

function handleHintKey(event: KeyboardEvent) {
  if (!hints || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === "Escape") {
    closeHints();
    return;
  }
  if ((event.ctrlKey || event.metaKey || event.altKey) && !event.getModifierState?.("AltGraph")) {
    return;
  }
  if (event.key.length !== 1) return;

  hints.typed += event.key.toLowerCase();
  const matches = hints.entries.filter((entry) => entry.label.startsWith(hints!.typed));
  if (matches.length === 0) {
    closeHints();
    return;
  }
  if (matches.length === 1 && matches[0]!.label === hints.typed) {
    const link = matches[0]!.link;
    closeHints();
    link.click();
    return;
  }
  paintHints();
}

function openPrompt(mode: "search" | "ex", direction: 1 | -1 = 1) {
  promptMode = mode;
  promptDirection = direction;
  promptPrefix.textContent = mode === "search" ? (direction > 0 ? "/" : "?") : ":";
  promptInput.value = "";
  promptInput.placeholder =
    mode === "search" ? "Search in document…" : ":e file · :mv · :rm · :q · :w";
  promptBar.hidden = false;
  promptInput.focus();
}

function closePrompt() {
  promptMode = undefined;
  promptBar.hidden = true;
  promptInput.blur();
}

function submitPrompt() {
  const value = promptInput.value;
  const mode = promptMode;
  const direction = promptDirection;
  closePrompt();

  if (mode === "search") {
    if (value.trim()) searchDocument(value, direction);
    else clearSearch();
  } else if (mode === "ex") {
    void runEx(value);
  }
}

async function listFiles() {
  const response = await api("/api/tree");
  const files = ((await response.json()) as { files: string[] }).files;
  rememberFiles(files);
  return files;
}

// --- Enlaces [[wiki]] ---------------------------------------------------------

// Archivos conocidos, contra los que se resuelven los enlaces [[wiki]]. `null`
// hasta la primera lectura del árbol.
let wikiFiles: Set<string> | null = null;
let wikiTimer: ReturnType<typeof setTimeout> | undefined;

/** Guarda la lista de archivos. Si cambia, los enlaces ya pintados se vuelven a resolver. */
function rememberFiles(files: readonly string[]) {
  const first = wikiFiles === null;
  const unchanged =
    wikiFiles !== null && wikiFiles.size === files.length && files.every((f) => wikiFiles!.has(f));
  if (unchanged) return;
  wikiFiles = new Set(files);
  setWikiFiles(files);
  if (!first) repaintWikiLinks();
}

async function refreshWikiFiles() {
  try {
    await listFiles();
  } catch {
    // Sin lista, los enlaces [[wiki]] quedan sin destino hasta el próximo intento.
  }
}

/** Vuelve a resolver los enlaces de la vista sin repintarla (conserva scroll y búsqueda). */
function repaintWikiLinks() {
  if (!active || editor || !editable || active.error) return;
  refreshWikiLinks(content, active.path);
}

/** Crear o borrar un archivo cambia a dónde apuntan (o si rompen) los enlaces. */
function scheduleWikiRefresh() {
  clearTimeout(wikiTimer);
  wikiTimer = setTimeout(() => void refreshWikiFiles(), 150);
}

function fileUrl(path: string) {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// --- Archivos recientes y alternado -----------------------------------------

function loadRecent() {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

function saveRecent() {
  try {
    localStorage.setItem(RECENT_KEY, serializeRecent(recent));
  } catch {
    // Sin localStorage la lista vive solo en memoria.
  }
}

function visit(path: string) {
  recent = recordVisit(recent, path);
  saveRecent();
}

/** `Ctrl-^`: vuelve al archivo anterior (el más reciente distinto del actual). */
async function alternateFile() {
  let files: string[];
  try {
    files = await listFiles();
  } catch (error) {
    notify(errorText(error), "error", 3000);
    return;
  }

  const path = alternatePath(recentChoices(recent, files), active?.path);
  if (!path) {
    notify("No alternate file", "warn", 2500);
    return;
  }
  openInNewTab(path);
}

// --- Saltar a una línea (resultados de la búsqueda de texto) ----------------

let pendingJump: { path: string; line: number } | undefined;

function takeJump(path: string) {
  if (pendingJump?.path !== path) return undefined;
  const { line } = pendingJump;
  pendingJump = undefined;
  return line;
}

function jumpTo(path: string, line: number) {
  const tab = findTab(path);
  if (tab && tab === active && tab.loaded && !tab.error) {
    if (editor) {
      // Se reabre el editor en la línea: así el cursor queda donde se espera.
      const cursor = cursorForLine(editor.view.state.doc.toString(), line);
      leaveEditor();
      tab.cursor = cursor;
      enterEditor(tab, { cursor, screenY: referenceY() });
    } else {
      scrollToSourceLine(line);
    }
    return;
  }

  pendingJump = { path, line };
  openInNewTab(path);
}

// --- Casillas de tareas ------------------------------------------------------

function taskBoxOf(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return null;
  return target.closest("li.task") ? target : null;
}

function refreshTaskCounts() {
  const boxes = content.querySelectorAll<HTMLInputElement>('li.task input[type="checkbox"]');
  let done = 0;
  boxes.forEach((box) => {
    if (box.checked) done++;
  });
  taskCounts = { done, total: boxes.length };
}

/** Pinta la vista renderizada con las casillas activas. */
function paintView(tab: Tab) {
  content.replaceChildren(renderMarkdown(tab.draft, tab.path, { interactive: true }));
  refreshTaskCounts();
}

/** Invierte la casilla de la línea `item` y la guarda con el ETag de la pestaña. */
async function commitTask(item: HTMLElement) {
  const tab = active;
  if (!tab || editor || !editable) return;

  const line = Number(item.dataset.line);
  const box = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const result = Number.isInteger(line) ? toggleTask(tab.draft, line) : null;
  if (!result) {
    // La vista y el texto no coinciden: se repinta desde el borrador.
    notify("Could not toggle the task", "warn", 2500);
    paintView(tab);
    invalidateBlocks();
    updateStatusPosition();
    return;
  }

  const wasDirty = tab.dirty;
  tab.draft = result.text;
  tab.dirty = tab.draft !== tab.raw;
  if (box) box.checked = result.checked;
  refreshTaskCounts();
  updateChrome();
  syncTabState();

  // Con cambios sin guardar no se escribe nada: se guardaría también lo demás.
  if (wasDirty) {
    notify("Task updated. You have unsaved changes: :w to save", "warn", 3000);
    return;
  }
  await saveDraft(tab);
}

/** `x`: invierte la tarea bajo el cursor de lectura. */
function toggleSelectedTask() {
  const element = currentBlock()?.element;
  const item = element
    ? (element.closest<HTMLElement>("li.task") ?? element.querySelector<HTMLElement>(":scope > li.task"))
    : null;
  if (!item) {
    notify("No task at the cursor", "warn", 2000);
    return;
  }
  void commitTask(item);
}

// --- Crear, renombrar y borrar archivos ------------------------------------

async function createFile(path: string, target: "new" | "current") {
  let created = true;
  try {
    await api(fileUrl(path), {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "",
    });
    notify(`Created ${path}`, "ok", 2500);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) {
      notify(errorText(error), "error", 3500);
      return;
    }
    created = false;
    notify(`${path} already exists`, "warn", 2500);
  }

  if (target === "current") openInCurrentTab(path);
  else openInNewTab(path);

  // Un archivo recién creado está vacío: se abre directamente para escribir.
  const tab = findTab(path);
  if (created && tab && !tab.dirty) tab.mode = "edit";
}

async function moveActive(input: string) {
  const tab = active;
  if (!tab) {
    notify("No file to rename", "warn", 2500);
    return;
  }

  const dest = normalizeNewPath(input);
  if (!dest) {
    notify(input.trim() ? "Invalid file name" : "Missing new name", "warn", 3000);
    return;
  }
  if (dest === tab.path) return;
  if (findTab(dest)) {
    notify(`${dest} is already open`, "warn", 3000);
    return;
  }
  if (tab.dirty) {
    notify("Save your changes before renaming (:w)", "warn", 3000);
    return;
  }

  // Se renombra la pestaña antes de la petición: los eventos del disco del
  // archivo viejo ya no la encuentran y no la tratan como borrada.
  const from = tab.path;
  tab.path = dest;
  renderTabs();
  updateChrome();

  try {
    await api("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: dest }),
    });
  } catch (error) {
    tab.path = from;
    renderTabs();
    updateChrome();
    notify(
      error instanceof ApiError && error.status === 409 ? `${dest} already exists` : errorText(error),
      "error",
      3500,
    );
    return;
  }

  recent = renameRecent(recent, from, dest);
  saveRecent();
  if (tab === active) {
    replaceUrl(viewUrl(dest));
    // Los enlaces e imágenes relativos se resuelven desde la nueva carpeta.
    if (!editor) {
      const y = scrollY;
      paintView(tab);
      scrollTo(0, y);
      invalidateBlocks();
    }
  }
  persistTabs();
  renderTabs();
  updateChrome();
  syncTabState();
  notify(`Renamed to ${dest}`, "ok", 2500);
}

async function removeActive(input: string, force: boolean) {
  const tab = active;
  if (!tab) {
    notify("No file to delete", "warn", 2500);
    return;
  }
  if (input.trim() && normalizeNewPath(input) !== tab.path) {
    notify(":rm only deletes the current file", "warn", 3000);
    return;
  }
  if (!force && !confirm(`Delete "${tab.path}" from disk? This cannot be undone.`)) {
    editor?.view.focus();
    return;
  }

  const path = tab.path;
  const headers: Record<string, string> = {};
  if (tab.etag && !force && !tab.conflict) headers["If-Match"] = tab.etag;

  try {
    await api(fileUrl(path), { method: "DELETE", headers });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
      notify("The file changed on disk. Use :rm! to delete it anyway.", "warn", 0);
    } else {
      notify(errorText(error), "error", 3500);
    }
    return;
  }

  recent = removeRecent(recent, path);
  saveRecent();
  closeTab(tab, { force: true });
  notify(`Deleted ${path}`, "ok", 3000);
}

function runFileCommand(command: FileCommand) {
  switch (command.name) {
    case "edit":
      void openPath(command.arg);
      return;
    case "mv":
      void moveActive(command.arg);
      return;
    case "rm":
      void removeActive(command.arg, command.force);
      return;
  }
}

/**
 * `:e nombre`: abre el archivo. Sin `.md` ni `/` se busca de forma difusa y solo
 * si no hay coincidencias se crea; con `.md` o `/` el nombre es exacto.
 */
async function openPath(input: string) {
  const text = input.trim();
  if (!text) {
    notify("Missing file name", "warn", 2500);
    return;
  }
  if (text === "#") {
    await alternateFile();
    return;
  }

  const path = normalizeNewPath(text);
  if (!path) {
    notify("Invalid file name", "warn", 3000);
    return;
  }

  const existing = findTab(path);
  if (existing) {
    switchTo(existing);
    return;
  }

  let files: string[];
  try {
    files = await listFiles();
  } catch (error) {
    notify(errorText(error), "error", 3000);
    return;
  }

  if (files.includes(path)) {
    openInCurrentTab(path);
    return;
  }

  const exact = text.toLowerCase().endsWith(".md") || text.includes("/");
  if (!exact) {
    const [best] = fuzzySearch(path, files);
    if (best) {
      openInCurrentTab(best.path);
      return;
    }
  }

  await createFile(path, "current");
}

async function runEx(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;

  // `!` puede ir pegado al comando (`:rm!`, `:q!`) o al final (`:e nuevo!`).
  const [head = "", ...args] = trimmed.split(/\s+/);
  const bang = head.endsWith("!");
  const command = (bang ? head.slice(0, -1) : head).toLowerCase();
  const force = bang || trimmed.endsWith("!");
  let argument = args.join(" ");
  if (!bang && trimmed.endsWith("!")) argument = argument.slice(0, -1).trim();

  switch (command) {
    case "e":
    case "edit":
      await openPath(argument);
      return;
    case "config":
      notify(
        loadedConfig.exists
          ? `Config: ${loadedConfig.path}${configWarnings.length > 0 ? ` (${configWarnings.length} warning${configWarnings.length === 1 ? "" : "s"})` : ""}`
          : `No config file. Create ${loadedConfig.path || "~/.config/markvi/config.toml"}`,
        "ok",
        6000,
      );
      return;
    case "mv":
    case "move":
    case "rename":
      await moveActive(argument);
      return;
    case "rm":
    case "delete":
    case "remove":
      await removeActive(argument, force);
      return;
    case "q":
    case "quit":
      if (!active) return;
      closeTab(active, { force });
      return;
    case "w":
    case "write":
      if (!active) return;
      if (!active.dirty) {
        notify("No changes to save", "ok", 2000);
        return;
      }
      await saveDraft(active);
      return;
    case "wq":
    case "x":
      if (!active) return;
      if (active.dirty && !(await saveDraft(active))) return;
      closeTab(active, { force: true });
      return;
    default:
      notify(`Unknown command: ${command}`, "error", 3000);
  }
}

function runViewCommand(command: ViewCommand) {
  switch (command.type) {
    case "moveBlock":
      moveBlock(command.count);
      return;
    case "halfPage":
      halfPage(command.direction);
      return;
    case "top":
      goTop(command.count);
      return;
    case "bottom":
      goBottom(command.count);
      return;
    case "heading":
      moveHeading(command.direction, command.count);
      return;
    case "search":
      openPrompt("search", command.direction);
      return;
    case "nextMatch":
      nextMatch(command.direction, command.count);
      return;
    case "hints":
      openHints();
      return;
    case "tab":
      switchTabBy(command.direction, command.count);
      return;
    case "history":
      goHistory(command.direction);
      return;
    case "toggleTask":
      toggleSelectedTask();
      return;
    case "alternate":
      void alternateFile();
      return;
    case "ex":
      openPrompt("ex");
      return;
    case "cancel":
      clearSearch();
      return;
  }
}

function paintViewPending() {
  if (editor) return;
  statusVim.textContent = viewNav.pending;
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

// Cambiar una variable CSS del <html> invalida el estilo de todo el documento, y
// esta función corre en cada notificación del ResizeObserver: solo si cambian.
let barHeight = -1;
let statusHeight = -1;
function syncLayoutMetrics() {
  const bh = bar.offsetHeight;
  const sh = statusBar.offsetHeight;
  if (bh !== barHeight) {
    barHeight = bh;
    document.documentElement.style.setProperty("--bar-height", `${bh}px`);
  }
  if (sh !== statusHeight) {
    statusHeight = sh;
    document.documentElement.style.setProperty("--status-height", `${sh}px`);
  }
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
      { label: "Reload", run: () => void reloadTab(tab, { discard: true }) },
      { label: "Overwrite", run: () => void saveDraft(tab, { force: true }) },
    ];
  }
  if (tab.conflict === "deleted") {
    const actions: StatusAction[] = [
      { label: "Recreate file", run: () => void recreateTab(tab) },
    ];
    actions.push(
      tab.dirty
        ? { label: "Discard changes", run: () => discardChanges(tab) }
        : { label: "Close tab", run: () => closeTab(tab) },
    );
    return actions;
  }
  if (tab.error) {
    return [{ label: "Retry", run: () => void showTab(tab) }];
  }
  return [];
}

// `renderStatus` corre en cada pulsación en el editor: los botones solo se
// reconstruyen si cambian las etiquetas; el clic usa siempre la acción vigente.
let statusActionList: StatusAction[] = [];
let statusActionKey = "";

function renderStatusActions(actions: StatusAction[]) {
  statusActionList = actions;
  const key = actions.map((action) => action.label).join("\u0000");
  if (key === statusActionKey) return;
  statusActionKey = key;
  statusActions.replaceChildren(
    ...actions.map((action, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset.primary = String(index === 0);
      button.addEventListener("click", () => {
        statusActionList[index]?.run();
        editor?.view.focus();
      });
      return button;
    }),
  );
}

function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

// `ln N/M` se repinta en cada fotograma de scroll: no recorrer todo el documento cada vez.
let lineCountText = "";
let lineCountValue = 1;
function totalLines(text: string) {
  if (text !== lineCountText) {
    lineCountText = text;
    lineCountValue = lineStarts(text).length;
  }
  return lineCountValue;
}

function updateStatusPosition() {
  let text = "";

  if (editor) {
    const state = editor.view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    text = `${line.number}:${head - line.from + 1}`;
  } else if (active && editable) {
    const total = totalLines(active.draft);
    const line = currentSourceLine() ?? 1;
    text = `ln ${line}/${total}`;
  }

  if (statusPosition.textContent !== text) statusPosition.textContent = text;

  const tasks =
    !editor && active && editable && taskCounts.total > 0
      ? `${taskCounts.done}/${taskCounts.total}`
      : "";
  setText(statusTasks, tasks);
}

function paintVimStatus() {
  if (!editor) {
    statusVim.textContent = "";
    return;
  }

  const status = editor.vimStatus();
  setText(statusMode, vimModeLabel(status.mode));
  if (statusMode.dataset.mode !== status.mode) statusMode.dataset.mode = status.mode;
  setText(statusVim, vimStatusText(status));
  updateStatusPosition();
}

function renderStatus() {
  const tab = active;
  const mode = editor ? editor.vimStatus().mode : tab ? "view" : "index";
  setText(statusMode, editor ? vimModeLabel(mode) : tab ? "View" : "Index");
  if (statusMode.dataset.mode !== mode) statusMode.dataset.mode = mode;
  setText(statusVim, editor ? vimStatusText(editor.vimStatus()) : viewNav.pending);
  setText(statusPath, tab ? tab.path : "");
  statusDirty.hidden = !tab?.dirty;

  let state = "Ready";
  let tone: StatusTone = "ok";
  let message = "";

  if (loading) {
    state = "Loading";
  } else if (tab) {
    if (tab.conflict === "changed") {
      state = "Conflict";
      tone = "warn";
      message = "The file changed on disk.";
    } else if (tab.conflict === "deleted") {
      state = "File deleted";
      tone = "error";
      message = "The file no longer exists.";
    } else if (tab.error) {
      state = "Error";
      tone = "error";
      message = tab.error;
    } else if (tab.dirty) {
      state = "Unsaved";
      tone = "warn";
    } else {
      state = "Saved";
    }
  }

  if (transient) {
    message = transient.message;
    tone = transient.tone;
  }

  setText(statusState, state);
  if (statusState.dataset.tone !== tone) statusState.dataset.tone = tone;
  setText(statusMessage, message);
  if (statusMessage.dataset.tone !== tone) statusMessage.dataset.tone = tone;
  if (statusMessage.title !== message) statusMessage.title = message;

  updateStatusPosition();
  renderStatusActions(tab ? statusActionsFor(tab) : []);
}

function renderTabs() {
  tabBar.hidden = tabs.length === 0;
  const fragment = document.createDocumentFragment();
  const labels = tabLabels(tabs.map((tab) => tab.path));

  tabs.forEach((tab, index) => {
    const item = element("div", "", "tab");
    item.dataset.path = tab.path;
    item.classList.toggle("is-active", tab === active);
    item.classList.toggle("is-dirty", tab.dirty);
    item.classList.toggle("is-conflict", !!tab.conflict);

    const link = document.createElement("a");
    link.className = "tab-link";
    link.href = viewUrl(tab.path);
    link.textContent = labels[index] ?? tab.path;
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
    close.title = `Close ${tab.path}`;
    close.setAttribute("aria-label", `Close ${tab.path}`);
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTab(tab);
    });

    item.append(link, close);
    fragment.append(item);
  });

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
  document.title = tab ? `${tab.dirty ? "● " : ""}${tab.path} · markvi` : "markvi";
  renderStatus();
}

function setTheme() {
  editor?.setDark(isDark(config, themePreference.matches));
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

function enterEditor(tab: Tab, options: { cursor?: number; screenY?: number } = {}) {
  if (tab !== active || editor || !editable || !tab.loaded || tab.error) return;

  const wasView = tab.mode === "view";
  // Desde la vista manda la posición de lectura (o la selección), no el cursor
  // guardado de la última edición. Un doble clic puede fijar ambas cosas.
  const cursor = options.cursor ?? (wasView ? readingCursor(tab) : tab.cursor);
  const screenY = options.screenY ?? (wasView ? referenceY() : undefined);

  tab.mode = "edit";
  if (wasView) tab.scroll = scrollY;
  if (!tab.dirty) tab.draft = tab.raw;
  tab.cursor = cursor;

  const host = element("div", "", "editor-host");
  clearSearch();
  closeHints();
  viewNav.reset();
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
    onNextTab: () => queueMicrotask(() => switchTab(1)),
    onPreviousTab: () => queueMicrotask(() => switchTab(-1)),
    onCommand: runFileCommand,
  });

  updateReadingIndicator();
  setTheme();
  updateChrome();
  syncTabState();
  persistTabs();
  vimStatusTimer = setInterval(paintVimStatus, 100);
}

// Los guardados de una misma pestaña van en cola: un segundo `:w` lanzado antes de
// que termine el primero usaría un etag viejo (If-Match) y fallaría con conflicto.
const saveQueue = new WeakMap<Tab, Promise<unknown>>();

function saveDraft(tab: Tab, options: { force?: boolean } = {}): Promise<boolean> {
  const previous = saveQueue.get(tab) ?? Promise.resolve();
  const run = previous.then(() => writeDraft(tab, options));
  saveQueue.set(
    tab,
    run.catch(() => undefined),
  );
  return run;
}

async function writeDraft(tab: Tab, options: { force?: boolean } = {}) {
  if (tab !== active) return false;

  const text = editor ? editor.view.state.doc.toString() : tab.draft;
  tab.draft = text;
  const savedRaw = tab.raw;
  const savedCursor = editor?.view.state.selection.main.head;
  const savedEtag = tab.etag;
  if (savedCursor !== undefined) tab.cursor = savedCursor;

  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
  if (tab.etag && !options.force) headers["If-Match"] = tab.etag;

  try {
    const response = await api(`/api/file?path=${encodeURIComponent(tab.path)}`, {
      method: "PUT",
      headers,
      body: text,
    });

    // Solo se descarta si otro flujo (recarga desde disco, recreateTab...) avanzó el
    // buffer mientras la petición estaba en vuelo. Comparar `raw` con `text` aquí
    // era el bug: con cambios sin guardar siempre difieren y se salía sin actualizar
    // raw/dirty/etag, dejando «Sin guardar» y un If-Match obsoleto.
    if (tab.raw !== savedRaw || tab.etag !== savedEtag) return true;

    const responseEtag = response.headers.get("etag") ?? savedEtag;
    tab.raw = text;
    // Si se guardó un borrador ya marcado como dirty (p. ej. forzado), comparar
    // el texto actual con el snapshot enviado y conservar cualquier edición nueva.
    tab.dirty = tab.draft !== text;
    tab.etag = responseEtag;
    if (tab.draft === text) tab.conflict = undefined;
    tab.loaded = true;
    tab.error = undefined;

    updateChrome();
    syncTabState();
    persistTabs();
    if (tab === active) notify("Saved to disk", "ok", 2500);
    return true;
  } catch (error) {
    if (tab.raw !== savedRaw || tab.etag !== savedEtag) {
      // Otro guardado/edición ya avanzó este buffer mientras fallaba la petición.
      return false;
    }
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
        clearSearch();
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
    notify("File recreated", "ok", 2500);
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
    notify("The file changed on disk: reload or overwrite.", "warn", 0);
  } else if (status === 404) {
    tab.conflict = "deleted";
    tab.etag = undefined;
    notify("The file no longer exists: you can recreate it with your changes.", "error", 0);
  } else if (status === 403) {
    notify(message, "error", 0);
  } else {
    notify(`Could not save: ${message}`, "error", 0);
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

    // El usuario pudo reanudar la edición mientras la petición estaba en vuelo.
    // No pisar el nuevo borrador; si el disco sigue en el último guardado solo
    // refrescamos su ETag, y si diverge de ambos contenidos marcamos conflicto.
    if (tab.dirty && !options.discard) {
      if (file.text === tab.raw) {
        tab.etag = file.etag;
      } else if (file.text === tab.draft) {
        // El disco ya contiene exactamente el borrador más reciente. Sincronizar
        // estado sin volver a despachar el documento al editor.
        tab.raw = file.text;
        tab.etag = file.etag;
        tab.dirty = false;
        tab.conflict = undefined;
        tab.loaded = true;
        tab.error = undefined;
        persistTabs();
        if (tab === active) updateChrome();
        syncTabState();
        return true;
      } else {
        tab.conflict = "changed";
        if (tab === active) {
          notify("The file changed on disk. You have unsaved changes.", "warn", 0);
          updateChrome();
        }
        syncTabState();
      }
      return false;
    }

    // fs.watch también notifica nuestras propias escrituras. Evitar incluso el
    // repintado de la vista/editor cuando el contenido no cambió.
    if (file.text === tab.raw && !options.discard && tab.loaded) {
      tab.etag = file.etag;
      if (tab === active) updateChrome();
      return true;
    }

    tab.raw = file.text;
    tab.draft = file.text;
    tab.dirty = false;
    // Sin el ETag nuevo, el siguiente guardado (o marcar una tarea) chocaría.
    tab.etag = file.etag;
    tab.loaded = true;
    tab.error = undefined;
    tab.conflict = undefined;

    if (tab === active) {
      if (editor) {
        editor.setDoc(tab.draft);
      } else {
        editable = true;
        const scroll = scrollY;
        clearSearch();
        paintView(tab);
        scrollTo(0, scroll);
        invalidateBlocks();
        updateReadingIndicator();
      }
      loading = false;
      updateChrome();
      renderTabs();
    } else {
      syncTabState();
    }

    persistTabs();
    notify(
      options.discard ? "Changes discarded and file reloaded" : "Reloaded from disk",
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
        tab.error = "File not found.";
        if (tab === active && !editor) {
          clearSearch();
          content.replaceChildren(
            renderErrorState(
              "Could not reload the file",
              tab.error,
              "Retry",
              () => void reloadTab(tab, { discard: true }),
            ),
          );
          editable = false;
        }
      }
      if (tab === active) notify("The file was deleted on disk.", "error", 0);
    } else if (tab === active) {
      notify(`Could not reload: ${message}`, "error", 0);
    }

    if (tab === active) loading = false;
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
    tab.error = "File not found.";
  }

  if (tab === active) {
    editable = !wasDeleted;
    clearSearch();
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
  notify("Changes discarded", "ok", 2500);
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
    if (hadChanges) notify("Changes discarded", "ok", 2500);
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

function renderErrorState(
  title: string,
  message: string,
  actionLabel: string,
  action: () => void,
) {
  const wrapper = element("div", "", "state state-error");
  wrapper.append(element("h2", title));
  wrapper.append(element("p", message, "muted"));
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = actionLabel;
  button.addEventListener("click", action);
  wrapper.append(button);
  return wrapper;
}

function buildIndex(files: string[]) {
  const wrapper = element("div", "", "index");
  const header = element("div", "", "index-header");
  header.append(element("h1", "Files"));
  header.append(
    element("p", "space + f find · space + t index · Enter open", "index-hint"),
  );
  wrapper.append(header);

  if (files.length === 0) {
    wrapper.append(element("p", "No .md files in this directory.", "index-empty"));
    return wrapper;
  }

  if (tabs.length > 0) {
    const section = element("section", "", "index-group");
    section.append(element("h2", "Recent"));
    const list = element("ul", "", "files");
    for (const tab of tabs) {
      const link = element("a", tab.path);
      link.href = viewUrl(tab.path);
      const item = document.createElement("li");
      item.append(link);
      list.append(item);
    }
    section.append(list);
    wrapper.append(section);
  }

  const groups = new Map<string, string[]>();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    const dir = slash < 0 ? "" : file.slice(0, slash);
    const group = groups.get(dir);
    if (group) group.push(file);
    else groups.set(dir, [file]);
  }

  for (const [dir, group] of groups) {
    const section = element("section", "", "index-group");
    section.append(element("h2", dir || "Root"));
    const list = element("ul", "", "files");
    for (const file of group) {
      const name = dir ? file.slice(dir.length + 1) : file;
      const link = element("a", name);
      link.href = viewUrl(file);
      link.title = file;
      const item = document.createElement("li");
      item.append(link);
      list.append(item);
    }
    section.append(list);
    wrapper.append(section);
  }

  return wrapper;
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
  viewNav.reset();
  closeHints();
  closePrompt();
  content.classList.remove("editing");
  loading = true;
  updateChrome();
  renderTabs();

  let nodes: Node;
  try {
    const { files } = (await (await api("/api/tree")).json()) as { files: string[] };
    nodes = buildIndex(files);
  } catch (error) {
    nodes = renderErrorState(
      "Could not load the index",
      error instanceof Error ? error.message : String(error),
      "Retry",
      () => void showIndex(),
    );
  }
  if (id !== request) return;

  loading = false;
  content.replaceChildren(nodes);
  scrollTo(0, 0);
  clearSearch();
  invalidateBlocks();
  updateReadingIndicator();
  updateChrome();
}

async function showTab(tab: Tab, scroll?: number) {
  const id = ++request;
  if (editor) leaveEditor();
  active = tab;
  editable = false;
  viewNav.reset();
  closeHints();
  closePrompt();
  content.classList.remove("editing");
  updateChrome();
  renderTabs();

  if (!tab.loaded) {
    loading = true;
    updateChrome();
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
    } finally {
      if (id === request) loading = false;
    }
  }

  if (id !== request) return;

  // Los enlaces [[wiki]] se resuelven al pintar: hace falta la lista de archivos.
  if (wikiFiles === null && !tab.error) {
    await refreshWikiFiles();
    if (id !== request) return;
  }

  if (tab.error) {
    clearSearch();
    content.replaceChildren(
      renderErrorState(
        "Could not open the file",
        tab.error,
        "Retry",
        () => void showTab(tab),
      ),
    );
    editable = false;
    invalidateBlocks();
    updateReadingIndicator();
    updateChrome();
    renderTabs();
    return;
  }

  editable = true;
  visit(tab.path);
  const jump = takeJump(tab.path);
  if (tab.mode === "edit") {
    if (jump) tab.cursor = cursorForLine(tab.draft, jump);
    enterEditor(tab);
    return;
  }

  paintView(tab);
  clearSearch();
  updateChrome();
  renderTabs();

  if (scroll !== undefined) scrollTo(0, scroll);
  else if (location.hash && currentPath() === tab.path) scrollToHash();
  else scrollTo(0, tab.scroll);
  invalidateBlocks();
  readingCursorState.clear();
  updateReadingIndicator();
  if (jump) scrollToSourceLine(jump);
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
    !confirm("You have unsaved changes. Discard them and open the file in this tab?")
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

function closeTab(tab: Tab, options: { force?: boolean } = {}) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;

  const wasActive = tab === active;
  if (wasActive) storeActiveState();
  if (
    tab.dirty &&
    !options.force &&
    !confirm(`"${tab.path}" has unsaved changes. Close the tab and discard them?`)
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
    notify("Index updated", "ok", 2000);
  } catch {
    // Si el árbol falla se mantiene el índice anterior.
  }
}

async function handleDiskChange(event: DiskEvent) {
  if (!active) scheduleIndexRefresh();
  if (event.type === "delete" || (wikiFiles !== null && !wikiFiles.has(event.path))) {
    scheduleWikiRefresh();
  }

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
            ? "The file was deleted on disk. You have unsaved changes."
            : "The file changed on disk. You have unsaved changes.",
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
  list: listFiles,
  read: readText,
  open(path) {
    openInNewTab(path);
  },
  // Sin coincidencias, `Enter` crea el archivo con lo escrito.
  create(path) {
    void createFile(path, "new");
  },
});

const recents = createFinder({
  async list() {
    return recentChoices(recent, await listFiles(), active?.path);
  },
  read: readText,
  open(path) {
    openInNewTab(path);
  },
  title: "Recent files",
  placeholder: "Recent files…",
  listLabel: "Recent files",
  emptyText: "No recent files.",
});

const grep = createGrep({
  async search(query, signal) {
    const response = await api(`/api/search?q=${encodeURIComponent(query)}`, { signal });
    return (await response.json()) as Awaited<ReturnType<Parameters<typeof createGrep>[0]["search"]>>;
  },
  read: readText,
  open: jumpTo,
});

const backlinks = createBacklinks({
  path: () => active?.path,
  async load(path) {
    const response = await api(`/api/backlinks?path=${encodeURIComponent(path)}`);
    return (await response.json()) as Awaited<ReturnType<Parameters<typeof createBacklinks>[0]["load"]>>;
  },
  read: readText,
  open: jumpTo,
});

const anyModalOpen = () =>
  finder.isOpen || recents.isOpen || grep.isOpen || backlinks.isOpen || toc.isOpen;

const toc = createSelector<Heading>({
  title: "Table of contents",
  placeholder: "Go to heading…",
  listLabel: "Headings",
  hint: "↑↓ or Ctrl+j/k move · Enter go · Esc close",
  empty: (query) => (query ? "No results." : "The document has no headings."),
  items() {
    if (!active) return [];
    const source = editor ? editor.view.state.doc.toString() : active.draft;
    return extractHeadings(source, config.render.frontmatter).map((heading) => ({
      key: String(heading.line),
      label: heading.text,
      data: heading,
    }));
  },
  initial(items) {
    if (items.length === 0) return 0;
    let line: number;
    if (editor) {
      const source = editor.view.state.doc.toString();
      line = lineAtOffset(lineStarts(source), editor.view.state.selection.main.head);
    } else {
      line = currentSourceLine() ?? currentHeadingLine();
    }
    let index = 0;
    items.forEach((item, position) => {
      if (item.data.line <= line) index = position;
    });
    return index;
  },
  renderItem(item, positions) {
    const heading = item.data;
    const row = element("span", "", "toc-row");
    row.style.setProperty("--toc-depth", String(heading.level - 1));
    const level = element("span", `h${heading.level}`, "toc-level");
    const title = element("span", "", "toc-title");
    title.append(highlight(item.label, positions));
    row.append(level, title);
    return row;
  },
  preview(item) {
    if (!active) return "";
    const heading = item.data;
    const blocks = navigationBlocks();
    let blockIndex = -1;
    blocks.forEach((block, index) => {
      if (block.line <= heading.line && heading.line <= block.endLine) blockIndex = index;
    });
    if (blockIndex >= 0) readingCursorState.set(blockIndex, blocks.length);
    const source = editor ? editor.view.state.doc.toString() : active.draft;
    const lines = source.split("\n");
    const section = lines.slice(heading.line - 1, heading.sectionEnd - 1);
    const truncated = section.length > 200;
    const fragment = renderMarkdown(section.slice(0, 200).join("\n"), active.path);
    if (truncated) fragment.append(element("p", "muted", "…"));
    return fragment;
  },
  previewTitle(item) {
    return item.label;
  },
  choose(item) {
    const heading = item.data;
    if (editor) {
      const offset = cursorForLine(editor.view.state.doc.toString(), heading.line);
      editor.view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
      editor.view.focus();
      return;
    }
    scrollToSourceLine(heading.line);
  },
  count(shown, total) {
    return total > 0 ? `${shown}/${total}` : "";
  },
});

const whichKey = element("div", "", "which-key");
whichKey.hidden = true;
whichKey.setAttribute("role", "status");
whichKey.setAttribute("aria-live", "polite");
document.body.append(whichKey);

let whichKeyTimer: ReturnType<typeof setTimeout> | undefined;

function hideWhichKey() {
  if (whichKeyTimer !== undefined) {
    clearTimeout(whichKeyTimer);
    whichKeyTimer = undefined;
  }
  whichKey.hidden = true;
}

function paintWhichKey() {
  const actions = leader.available();
  if (actions.length === 0) {
    hideWhichKey();
    return;
  }

  const pending = leader.pending;
  const fragment = document.createDocumentFragment();
  for (const action of actions) {
    const row = element("div", "", "which-key-row");
    const key = element("kbd", keyLabel(action.keys[pending.length] ?? ""), "which-key-key");
    const label = element("span", action.label ?? action.keys.join(""), "which-key-label");
    row.append(key, label);
    fragment.append(row);
  }
  whichKey.replaceChildren(fragment);
  whichKey.hidden = false;
}

function scheduleWhichKey() {
  if (whichKeyTimer !== undefined) clearTimeout(whichKeyTimer);
  whichKeyTimer = setTimeout(() => {
    whichKeyTimer = undefined;
    if (leader.active) paintWhichKey();
  }, 300);
}

const leaderRunners: Record<string, { label: string; run: () => void }> = {
  find: { label: "Find file", run: () => finder.open() },
  grep: { label: "Search text", run: () => grep.open() },
  recent: { label: "Recent files", run: () => recents.open() },
  alternate: { label: "Alternate file", run: () => void alternateFile() },
  toc: {
    label: "Table of contents",
    run: () => {
      if (active) toc.open();
    },
  },
  backlinks: {
    label: "Backlinks",
    run: () => {
      if (active) backlinks.open();
    },
  },
  close: {
    label: "Close tab",
    run: () => {
      if (active) closeTab(active);
    },
  },
};

// Los atajos vienen de la configuración (ya fusionados con los de serie). Una
// acción que empieza por `:` ejecuta ese comando ex.
const leader = createLeader(
  config.leaderBindings.flatMap(({ keys, action }) => {
    if (action.startsWith(":")) {
      const command = action.slice(1).trim();
      return [{ keys, label: action, run: () => void runEx(command) }];
    }
    const runner = leaderRunners[action];
    return runner ? [{ keys, label: runner.label, run: runner.run }] : [];
  }),
  { timeout: 0, onCancel: hideWhichKey },
);

document.addEventListener("click", () => {
  if (leader.active) leader.cancel();
});

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return;

  // [[Enlace]] a un archivo que no existe: se ofrece crearlo.
  const create = link.dataset.wikiCreate;
  if (create) {
    event.preventDefault();
    if (confirm(`${create} does not exist. Create it?`)) void createFile(create, "current");
    return;
  }

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

// Doble clic en un bloque: abre el editor en la línea de ese punto y deja el
// cursor a la misma altura bajo el puntero.
content.addEventListener("dblclick", (event) => {
  if (editor || !active || !editable || event.button !== 0) return;
  if (promptMode || hints) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const target = event.target instanceof Element ? event.target : null;
  // Un enlace ya navega con el primer clic; no se abre el editor encima.
  if (target?.closest("a[href]")) return;
  // Las casillas ya reaccionan al clic: el doble clic no abre el editor.
  if (taskBoxOf(target)) return;
  const line = lineAtPoint(target, event.clientY);
  if (line === undefined) return;

  event.preventDefault();
  window.getSelection()?.removeAllRanges();
  enterEditor(active, {
    cursor: cursorForLine(active.draft, line),
    screenY: event.clientY,
  });
});

// Casillas de tareas. Sin foco (mousedown cancelado) para que las teclas de la
// vista sigan funcionando; el clic escribe el cambio en el archivo.
content.addEventListener("mousedown", (event) => {
  if (taskBoxOf(event.target)) event.preventDefault();
});

content.addEventListener("click", (event) => {
  const box = taskBoxOf(event.target);
  if (!box) return;
  const item = box.closest<HTMLElement>("li.task");
  if (!item || editor || !active || !editable) {
    event.preventDefault();
    return;
  }
  void commitTask(item);
});

// Clic simple: sitúa el marcador de lectura en esa línea y desplaza la vista si
// es necesario. Se excluyen enlaces, selecciones activas y el primer clic de un
// doble clic (para no mover el marcador antes de abrir el editor).
content.addEventListener("click", (event) => {
  if (editor || !active || !editable || event.button !== 0) return;
  if (promptMode || hints) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  // El segundo clic de un doble clic abre el editor (dblclick): no se mueve dos veces.
  if (event.detail > 1) return;

  const target = event.target instanceof Element ? event.target : null;
  // Los enlaces navegan con el primer clic; no reasignamos el marcador.
  if (target?.closest("a[href]")) return;
  if (taskBoxOf(target)) return;
  // Una selección en curso anula el click: el usuario está arrastrando texto.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;

  const line = lineAtPoint(target, event.clientY);
  if (line === undefined) return;

  // El punto ya está a la vista: se fija el cursor sin desplazar la página.
  const index = sourceBlockIndex(line);
  if (index < 0) return;
  readingCursorState.set(index, navigationBlocks().length);
  scheduleReadingIndicator();
});

window.addEventListener("popstate", () => {
  restoreFromUrl();
});

// Las pistas de enlaces capturan las teclas antes que el resto de la vista.
document.addEventListener("keydown", handleHintKey, true);

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitPrompt();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePrompt();
  }
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

    if (
      !leader.active &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      (event.key === "^" || event.key === "6") &&
      editor.vimStatus().mode === "normal"
    ) {
      event.preventDefault();
      event.stopPropagation();
      void alternateFile();
      return;
    }

    if (leader.active) {
      if (isModifierKey(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      hideWhichKey();
      const result = leader.feed(event.key);
      if (result === "pending") scheduleWhichKey();
      return;
    }

    if (isLeaderKey(event) && editor.vimStatus().mode === "normal") {
      event.preventDefault();
      event.stopPropagation();
      leader.start();
      scheduleWhichKey();
    }
  },
  true,
);

document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (anyModalOpen() || promptMode || hints) return;

  const target = event.target;
  const inEditor = editor?.view.dom.contains(target as Node) ?? false;
  if (inEditor || isTypingTarget(target)) return;

  if (leader.active) {
    if (isModifierKey(event.key)) return;
    event.preventDefault();
    hideWhichKey();
    const result = leader.feed(event.key);
    if (result === "pending") scheduleWhichKey();
    return;
  }

  if (isLeaderKey(event)) {
    event.preventDefault();
    leader.start();
    scheduleWhichKey();
    return;
  }

  // `[keymap.view]`: otra tecla puede hacer de `j`, `k`, `a`... (sin modificadores).
  const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
  const viewKey = plain ? (config.viewRemap[event.key] ?? event.key) : event.key;

  if (!editor && editable && active) {
    const command = viewNav.handle({
      key: viewKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
      altGraph: event.getModifierState?.("AltGraph") ?? false,
    });
    paintViewPending();

    if (command) {
      event.preventDefault();
      runViewCommand(command);
      return;
    }
    if (viewNav.pending) {
      event.preventDefault();
      return;
    }
  }

  if (event.altKey || event.ctrlKey || event.metaKey) return;

  const key = viewKey.toLowerCase();
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
  closeHints();
  invalidateBlocks();
  syncLayoutMetrics();
  scheduleReadingIndicator();
};

window.addEventListener(
  "scroll",
  () => {
    const blocks = navigationBlocks();
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    if (programmaticScrollTarget !== undefined && Math.abs(scrollY - programmaticScrollTarget) <= 2) {
      programmaticScrollTarget = undefined;
      scheduleReadingIndicator();
      return;
    }
    programmaticScrollTarget = undefined;
    const readingY = readingReferenceY(
      referenceY() + scrollY,
      statusBar.getBoundingClientRect().top + scrollY,
      scrollY,
      maxScroll,
    );
    const next = readingBlockIndex(blocks, readingY, scrollY, maxScroll);
    readingCursorState.set(next, blocks.length);
    scheduleReadingIndicator();
  },
  { passive: true },
);
// En los topes del scroll (o en documentos sin scroll) la rueda ya no produce
// eventos `scroll`: se traduce en pasos del cursor de bloque hasta el primero/último.
let wheelAccum = 0;
let wheelTime = 0;
window.addEventListener(
  "wheel",
  (event) => {
    if (editor || !active || !editable || event.ctrlKey || event.deltaY === 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="dialog"]')) return;

    const direction = event.deltaY > 0 ? 1 : -1;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const atEdge =
      maxScroll <= 1 ||
      (direction < 0 && scrollY <= 0) ||
      (direction > 0 && scrollY >= maxScroll - 1);
    if (!atEdge) {
      wheelAccum = 0;
      return;
    }

    const now = performance.now();
    if (now - wheelTime > 200 || Math.sign(wheelAccum) !== direction) wheelAccum = 0;
    wheelTime = now;
    wheelAccum += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    if (Math.abs(wheelAccum) < 40) return;
    wheelAccum = 0;
    moveBlock(direction);
  },
  { passive: true },
);
// Fuera del callback del ResizeObserver: relayout cambia métricas/estilos de lo que
// se observa y el navegador avisa «ResizeObserver loop completed with undelivered
// notifications» (el overlay de Bun lo muestra como Runtime error).
let relayoutFrame = 0;
const scheduleRelayout = () => {
  if (relayoutFrame) return;
  relayoutFrame = requestAnimationFrame(() => {
    relayoutFrame = 0;
    relayout();
  });
};

window.addEventListener("resize", scheduleRelayout);

if (typeof ResizeObserver !== "undefined") {
  const observer = new ResizeObserver(scheduleRelayout);
  observer.observe(bar);
  observer.observe(statusBar);
  observer.observe(content);
}

const initialPath = currentPath();
if (configWarnings.length > 0) {
  for (const warning of configWarnings) console.warn(`markvi config: ${warning}`);
}
if (initialPath) {
  const tab = ensureTab(initialPath);
  active = tab;
  persistTabs();
  renderTabs();
  void showTab(tab);
} else {
  void showIndex();
}

// Un aviso a la vista (todos van a la consola); `:config` recuerda de dónde se lee.
if (configWarnings.length > 0) {
  const more = configWarnings.length > 1 ? ` (+${configWarnings.length - 1} more, see the console)` : "";
  notify(`Config: ${configWarnings[0]}${more}`, "warn", 10000);
}
