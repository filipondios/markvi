// Máquina de estados del teclado de la portada, independiente de `viewnav.ts`
// (que sigue dedicado al documento abierto). Recibe teclas y devuelve comandos:
// el DOM y el filtro viven en `list.ts`, así que esto se prueba sin navegador.

import type { ViewKey } from "../viewnav.ts";

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
  let count = "";
  let pendingG = false;

  const reset = () => {
    count = "";
    pendingG = false;
  };

  const takeCount = () => (count ? Number(count) : undefined);

  return {
    get pending() {
      return count + (pendingG ? "g" : "");
    },

    reset,

    handle(input) {
      const { key } = input;
      if (input.meta || (input.alt && !input.altGraph)) return undefined;

      // Las combinaciones con Ctrl (medio página, histórico…) son del documento:
      // aquí no aplican y el prefijo pendiente se descarta.
      if (input.ctrl && !input.altGraph) {
        reset();
        return undefined;
      }

      // Un prefijo pendiente consume la tecla siguiente, aunque sea dígito.
      if (pendingG) {
        pendingG = false;
        reset();
        return key === "g" ? { type: "top" } : undefined;
      }

      if (/^[0-9]$/.test(key)) {
        // `0` solo cuenta dentro de un número (`10j`); solo no es un comando.
        if (key === "0" && count === "") return undefined;
        count += key;
        return undefined;
      }

      const n = takeCount();

      switch (key) {
        case "g":
          pendingG = true;
          return undefined;
        case "j":
          reset();
          return { type: "move", count: n ?? 1 };
        case "k":
          reset();
          return { type: "move", count: -(n ?? 1) };
        case "G":
          reset();
          return { type: "bottom" };
        case "/":
          reset();
          return { type: "filter" };
        case "Enter":
          reset();
          return { type: "open" };
        case "Escape":
          reset();
          return { type: "cancel" };
        default:
          reset();
          return undefined;
      }
    },
  };
}
