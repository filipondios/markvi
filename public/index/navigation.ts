// Máquina de estados del teclado de la portada, independiente de `viewnav.ts`
// (que sigue dedicado al documento abierto). Recibe teclas y devuelve comandos:
// el DOM y el filtro viven en `list.ts`, así que esto se prueba sin navegador.

import { createCountState, isPlainControl, isPlainKey, type ViewKey } from "../keynav.ts";

export type { ViewKey } from "../keynav.ts";

export type ListCommand =
  | { type: "move"; count: number }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "filter" }
  | { type: "open" }
  | { type: "cancel" };

export interface ListNav {
  /** Texto pendiente para la barra de estado, p. ej. `5` o `g`. */
  readonly pending: string;
  handle(input: ViewKey): ListCommand | undefined;
  reset(): void;
}

export function createListNav(): ListNav {
  const state = createCountState();

  return {
    get pending() {
      return state.pending;
    },

    reset: () => state.reset(),

    handle(input) {
      const { key } = input;
      if (!isPlainKey(input)) return undefined;

      // Las combinaciones con Ctrl (medio página, histórico…) son del documento:
      // aquí no aplican y el prefijo pendiente se descarta.
      if (isPlainControl(input)) {
        state.reset();
        return undefined;
      }

      // Un prefijo pendiente consume la tecla siguiente, aunque sea dígito.
      if (state.prefix) {
        state.reset();
        return key === "g" ? { type: "top" } : undefined;
      }

      if (state.digit(key)) return undefined;

      const n = state.take();

      switch (key) {
        case "g":
          state.setPrefix("g");
          return undefined;
        case "j":
          state.reset();
          return { type: "move", count: n ?? 1 };
        case "k":
          state.reset();
          return { type: "move", count: -(n ?? 1) };
        case "G":
          state.reset();
          return { type: "bottom" };
        case "/":
          state.reset();
          return { type: "filter" };
        case "Enter":
          state.reset();
          return { type: "open" };
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
