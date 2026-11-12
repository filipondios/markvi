import { markdown } from "@codemirror/lang-markdown";
import { history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, GutterMarker, gutter, keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import type { VimStatus } from "./vimui.ts";
import { minimalTextChange } from "./textchange.ts";

export interface EditorSession {
  view: EditorView;
  setDark(dark: boolean): void;
  /** Sustituye el documento conservando (o moviendo) el cursor. */
  setDoc(doc: string, cursor?: number): void;
  vimStatus(): VimStatus;
  destroy(): void;
}

export interface EditorExitOptions {
  /** Guardar antes de salir. */
  save?: boolean;
  /** Descartar los cambios locales. */
  discard?: boolean;
}

export interface EditorOptions {
  onChange: (value: string) => void;
  onSave: () => Promise<boolean> | boolean;
  onExit: (options?: EditorExitOptions) => void | Promise<void>;
  onMessage: (message: string) => void;
  hasChanges: () => boolean;
  cursor: number;
  /** Altura de pantalla donde debe quedar la línea del cursor al abrir. */
  screenY?: number;
  /** Cambiar de pestaña desde modo Normal (`gt` / `gT`). */
  onNextTab?: () => void;
  onPreviousTab?: () => void;
  /** Comandos ex de archivos (`:e`, `:mv`, `:rm`): los resuelve la aplicación. */
  onCommand?: (command: FileCommand) => void;
}

export interface FileCommand {
  name: "edit" | "mv" | "rm";
  /** Argumento sin el `!` inicial ni espacios. */
  arg: string;
  /** Se escribió `!` (p. ej. `:rm!`, `:e! nuevo`). */
  force: boolean;
}

interface SessionControls {
  command(command: FileCommand): void;
  save(): Promise<boolean> | boolean;
  exit(options?: EditorExitOptions): void | Promise<void>;
  message(message: string): void;
  hasChanges(): boolean;
  nextTab(): void;
  previousTab(): void;
  setNumber(value: boolean): void;
  setRelative(value: boolean): void;
  setScrolloff(value: number): void;
  getNumber(): boolean;
  getRelative(): boolean;
  getScrolloff(): number;
}

let active: SessionControls | undefined;
let defaultNumber = true;
let defaultRelative = false;
let defaultScrolloff = 0;

function numberOption(value?: boolean) {
  if (value === undefined) return active?.getNumber() ?? defaultNumber;
  defaultNumber = value;
  active?.setNumber(value);
  return value;
}

function relativeOption(value?: boolean) {
  if (value === undefined) return active?.getRelative() ?? defaultRelative;
  defaultRelative = value;
  active?.setRelative(value);
  return value;
}

function scrolloffOption(value?: number) {
  if (value === undefined) return active?.getScrolloff() ?? defaultScrolloff;
  defaultScrolloff = Math.max(0, Math.round(value));
  active?.setScrolloff(defaultScrolloff);
  return defaultScrolloff;
}

Vim.defineOption("number", true, "boolean", ["nu"], numberOption);
Vim.defineOption("relativenumber", false, "boolean", ["rnu"], relativeOption);
Vim.defineOption("scrolloff", 0, "number", ["so"], scrolloffOption);

// Los comandos ex son globales en la librería; solo hay un editor a la vez.
// Salir se aplaza: la librería sigue usando el editor al cerrar el prompt `:`.
const exitSoon = (options?: EditorExitOptions) => {
  queueMicrotask(() => void active?.exit(options));
};

Vim.defineEx("write", "w", () => {
  void active?.save();
});
Vim.defineEx("wq", "wq", () => {
  exitSoon({ save: true });
});
Vim.defineEx("xit", "x", () => {
  if (!active) return;
  exitSoon({ save: active.hasChanges() });
});
Vim.defineEx("quit", "q", (_cm, params) => {
  if (!active) return;
  if (params.argString?.trim() === "!") {
    exitSoon({ discard: true });
    return;
  }
  if (active.hasChanges()) {
    active.message("No write since last change, add ! to override");
    return;
  }
  exitSoon();
});

// Las líneas están ajustadas: en Normal y Visual `j`/`k` bajan por línea de
// pantalla. Con operador (`dj`) siguen siendo líneas lógicas del archivo.
for (const context of ["normal", "visual"]) {
  Vim.map("j", "gj", context);
  Vim.map("k", "gk", context);
}
Vim.map("ZZ", ":x<CR>", "normal");
Vim.map("ZQ", ":q!<CR>", "normal");

// `gt` / `gT` cambian de pestaña también desde modo Normal. Los comandos ex
// son globales y llaman a la sesión activa.
// Comandos de archivos: el editor solo los reenvía a la aplicación, que sabe
// de rutas, pestañas y confirmaciones.
function defineFileCommand(name: FileCommand["name"], full: string, short?: string) {
  Vim.defineEx(full, short, (_cm, params) => {
    const raw = (params.argString ?? "").trim();
    const force = raw.startsWith("!");
    const arg = (force ? raw.slice(1) : raw).trim();
    const command: FileCommand = { name, arg, force };
    // Se aplaza: la librería sigue usando el editor al cerrar el prompt `:`.
    queueMicrotask(() => active?.command(command));
  });
}
defineFileCommand("edit", "edit", "e");
defineFileCommand("mv", "mv");
defineFileCommand("rm", "rm");

Vim.defineEx("tabnext", "tabn", () => active?.nextTab());
Vim.defineEx("tabprevious", "tabp", () => active?.previousTab());
Vim.map("gt", ":tabnext<CR>", "normal");
Vim.map("gT", ":tabprevious<CR>", "normal");

class NumberMarker extends GutterMarker {
  readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  override eq(other: GutterMarker) {
    return other instanceof NumberMarker && other.text === this.text;
  }

  override toDOM() {
    return document.createTextNode(this.text);
  }
}

function numberGutter(relative: boolean) {
  return gutter({
    class: "cm-lineNumbers",
    lineMarker(view, line) {
      const number = view.state.doc.lineAt(line.from).number;
      if (!relative) return new NumberMarker(String(number));
      const current = view.state.doc.lineAt(view.state.selection.main.head).number;
      return new NumberMarker(
        number === current ? String(number) : String(Math.abs(number - current)),
      );
    },
    lineMarkerChange: (update) => update.docChanged || update.selectionSet || update.viewportChanged,
    initialSpacer: () => new NumberMarker("99"),
  });
}

function keepScrolloff(view: EditorView, lines: number) {
  if (lines <= 0) return;

  const coords = view.coordsAtPos(view.state.selection.main.head);
  if (!coords) return;

  const rect = view.scrollDOM.getBoundingClientRect();
  const margin = lines * view.defaultLineHeight;
  if (coords.top < rect.top + margin) {
    view.scrollDOM.scrollTop -= rect.top + margin - coords.top;
  } else if (coords.bottom > rect.bottom - margin) {
    view.scrollDOM.scrollTop += coords.bottom - (rect.bottom - margin);
  }
}

export function createEditor(
  parent: HTMLElement,
  initial: string,
  options: EditorOptions,
): EditorSession {
  const theme = new Compartment();
  const gutterCompartment = new Compartment();
  let number = defaultNumber;
  let relative = defaultRelative;
  let scrolloff = defaultScrolloff;
  let view: EditorView;

  const editorTheme = EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "var(--font-mono)",
        lineHeight: "1.6",
      },
      ".cm-content": { padding: "1rem 0" },
      ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted)", border: "none" },
      ".cm-activeLineGutter, .cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--surface) 70%, transparent)",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
      "&.cm-focused": { outline: "none" },
    },
    { dark: false },
  );

  const applyGutter = () => {
    view.dispatch({
      effects: gutterCompartment.reconfigure(number ? numberGutter(relative) : []),
    });
  };

  const controls: SessionControls = {
    save: options.onSave,
    exit: options.onExit,
    message: options.onMessage,
    hasChanges: options.hasChanges,
    command: options.onCommand ?? (() => {}),
    nextTab: options.onNextTab ?? (() => {}),
    previousTab: options.onPreviousTab ?? (() => {}),
    setNumber(value) {
      number = value;
      applyGutter();
    },
    setRelative(value) {
      relative = value;
      applyGutter();
    },
    setScrolloff(value) {
      scrolloff = Math.max(0, Math.round(value));
      keepScrolloff(view, scrolloff);
    },
    getNumber: () => number,
    getRelative: () => relative,
    getScrolloff: () => scrolloff,
  };

  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        // Vim debe ir antes que los demás keymaps.
        vim(),
        gutterCompartment.of(number ? numberGutter(relative) : []),
        history(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...historyKeymap, indentWithTab]),
        drawSelection(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) keepScrolloff(update.view, scrolloff);
        }),
        theme.of(editorTheme),
      ],
    }),
  });

  const cursor = Math.max(0, Math.min(options.cursor, view.state.doc.length));
  view.dispatch({ selection: { anchor: cursor } });
  active = controls;
  view.focus();
  if (options.screenY !== undefined) {
    const target = options.screenY;
    const place = () => {
      if (!view.dom.isConnected) return;
      const block = view.lineBlockAt(cursor);
      const top = view.scrollDOM.getBoundingClientRect().top;
      view.scrollDOM.scrollTop = Math.max(0, block.top - (target - top));
    };
    place();
    // La primera medida estima la altura; se corrige con el layout real.
    requestAnimationFrame(() => {
      if (!view.dom.isConnected) return;
      const coords = view.coordsAtPos(cursor);
      if (coords) view.scrollDOM.scrollTop += coords.top - target;
      else place();
    });
  }

  return {
    view,
    setDark: (dark) => {
      view.dispatch({ effects: theme.reconfigure([editorTheme, ...(dark ? [oneDark] : [])]) });
    },
    setDoc: (doc, cursor = view.state.selection.main.head) => {
      const current = view.state.doc.toString();
      if (current === doc) return;

      const position = Math.max(0, Math.min(cursor, doc.length));
      const scrollDOM = view.scrollDOM;
      const scrollTop = scrollDOM.scrollTop;
      const scrollLeft = scrollDOM.scrollLeft;
      const change = minimalTextChange(current, doc);
      view.dispatch({
        changes: change,
        selection: { anchor: position },
        scrollIntoView: false,
      });
      scrollDOM.scrollTop = scrollTop;
      scrollDOM.scrollLeft = scrollLeft;
    },
    vimStatus: () => {
      const state = getCM(view)?.state.vim;
      const macro = Vim.getVimGlobalState_().macroModeState;
      return {
        mode: state?.mode ?? "normal",
        // `status` es lo que la librería pinta en su propia barra; `keyBuffer`
        // no siempre conserva el prefijo pendiente.
        pending: state?.status || state?.inputState?.keyBuffer.join("") || "",
        recording: macro.isRecording ? macro.latestRegister : undefined,
      };
    },
    destroy: () => {
      if (active === controls) active = undefined;
      view.destroy();
    },
  };
}
