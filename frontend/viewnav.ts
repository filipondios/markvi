// Navegación estilo Vim en la vista renderizada. Es una máquina de estados
// pura: recibe teclas y devuelve comandos. El DOM, el scroll y los modales
// viven en `app.ts`, así que esto se puede probar sin navegador.

import { createCountState, isPlainControl, isPlainKey, type ViewKey } from "./keynav.ts";

export type { ViewKey } from "./keynav.ts";

export type ViewCommand =
  | { type: "moveBlock"; count: number }
  | { type: "halfPage"; direction: 1 | -1 }
  | { type: "top"; count?: number }
  | { type: "bottom"; count?: number }
  | { type: "heading"; direction: 1 | -1; count: number }
  | { type: "search"; direction: 1 | -1 }
  | { type: "nextMatch"; direction: 1 | -1; count: number }
  | { type: "hints" }
  | { type: "tab"; direction: 1 | -1; count?: number }
  | { type: "history"; direction: 1 | -1 }
  | { type: "toggleTask" }
  | { type: "alternate" }
  | { type: "ex" }
  | { type: "cancel" };

export interface ViewNav {
  /** Texto pendiente para la barra de estado, p. ej. `5`, `g` o `2g`. */
  readonly pending: string;
  handle(input: ViewKey): ViewCommand | undefined;
  reset(): void;
}

export function createViewNav(): ViewNav {
  const state = createCountState();

  return {
    get pending() {
      return state.pending;
    },

    reset: () => state.reset(),

    handle(input) {
      const { key } = input;
      if (!isPlainKey(input)) return undefined;

      if (isPlainControl(input)) {
        state.reset();
        switch (key) {
          case "d":
            return { type: "halfPage", direction: 1 };
          case "u":
            return { type: "halfPage", direction: -1 };
          case "o":
            return { type: "history", direction: -1 };
          case "i":
            return { type: "history", direction: 1 };
          // Como en Vim, `Ctrl-^` y `Ctrl-6` saltan al archivo anterior.
          case "^":
          case "6":
            return { type: "alternate" };
          default:
            return undefined;
        }
      }

      // Una secuencia pendiente consume la siguiente tecla, aunque sea un
      // dígito: `g0` no es un contador.
      if (state.prefix) {
        const current = state.prefix;
        const n = state.take();
        state.reset();

        if (current === "g") {
          if (key === "g") return { type: "top", count: n };
          if (key === "t") return { type: "tab", direction: 1, count: n };
          if (key === "T") return { type: "tab", direction: -1, count: n };
        } else if (current === "]" && key === "]") {
          return { type: "heading", direction: 1, count: n ?? 1 };
        } else if (current === "[" && key === "[") {
          return { type: "heading", direction: -1, count: n ?? 1 };
        }
        return undefined;
      }

      if (state.digit(key)) return undefined;

      const n = state.take();

      switch (key) {
        case "g":
          state.setPrefix("g");
          return undefined;
        case "]":
          state.setPrefix("]");
          return undefined;
        case "[":
          state.setPrefix("[");
          return undefined;
        case "j":
          state.reset();
          return { type: "moveBlock", count: n ?? 1 };
        case "k":
          state.reset();
          return { type: "moveBlock", count: -(n ?? 1) };
        case "G":
          state.reset();
          return { type: "bottom", count: n };
        case "/":
          state.reset();
          return { type: "search", direction: 1 };
        case "?":
          state.reset();
          return { type: "search", direction: -1 };
        case "n":
          state.reset();
          return { type: "nextMatch", direction: 1, count: n ?? 1 };
        case "N":
          state.reset();
          return { type: "nextMatch", direction: -1, count: n ?? 1 };
        case "f":
          state.reset();
          return { type: "hints" };
        case "x":
          state.reset();
          return { type: "toggleTask" };
        case ":":
          state.reset();
          return { type: "ex" };
        case "Escape":
          state.reset();
          return { type: "cancel" };
        default:
          state.reset();
          return undefined;
      }
    },
  };
}
