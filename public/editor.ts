import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";

export interface EditorSession {
  view: EditorView;
  setDark(dark: boolean): void;
  /** Sustituye el documento conservando (o moviendo) el cursor. */
  setDoc(doc: string, cursor?: number): void;
  destroy(): void;
}

export interface EditorOptions {
  onChange: (value: string) => void;
  onSave: () => void;
  onExit: () => void;
  cursor: number;
}

export function createEditor(
  parent: HTMLElement,
  initial: string,
  options: EditorOptions,
): EditorSession {
  const theme = new Compartment();
  const editorTheme = EditorView.theme({
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)" },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      lineHeight: "1.6",
    },
    ".cm-content": { padding: "1rem 0" },
    ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted)", border: "none" },
    ".cm-activeLineGutter, .cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--surface) 70%, transparent)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    "&.cm-focused": { outline: "none" },
  }, { dark: false });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        // Antes que `defaultKeymap` para ganarle a `Escape: simplifySelection`.
        keymap.of([
          { key: "Escape", run: () => { options.onExit(); return true; } },
          { key: "Mod-s", run: () => { options.onSave(); return true; } },
        ]),
        lineNumbers(),
        history(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
        theme.of(editorTheme),
      ],
    }),
  });

  const cursor = Math.max(0, Math.min(options.cursor, view.state.doc.length));
  view.dispatch({ selection: { anchor: cursor } });
  view.focus();

  return {
    view,
    setDark: (dark) => {
      view.dispatch({ effects: theme.reconfigure([editorTheme, ...(dark ? [oneDark] : [])]) });
    },
    setDoc: (doc, cursor = view.state.selection.main.head) => {
      const position = Math.max(0, Math.min(cursor, doc.length));
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: position },
      });
    },
    destroy: () => view.destroy(),
  };
}
