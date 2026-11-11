// Navegación estilo Vim en la vista renderizada. Es una máquina de estados
// pura: recibe teclas y devuelve comandos. El DOM, el scroll y los modales
// viven en `app.ts`, así que esto se puede probar sin navegador.

export interface ViewKey {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  /** AltGr: en algunas distribuciones produce `]`, `[`, `{`… */
  altGraph?: boolean;
}

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
  | { type: "ex" }
  | { type: "cancel" };

export interface ViewNav {
  /** Texto pendiente para la barra de estado, p. ej. `5`, `g` o `2g`. */
  readonly pending: string;
  handle(input: ViewKey): ViewCommand | undefined;
  reset(): void;
}

export function createViewNav(): ViewNav {
  let count = "";
  let prefix = "";

  const reset = () => {
    count = "";
    prefix = "";
  };

  const takeCount = () => (count ? Number(count) : undefined);

  return {
    get pending() {
      return count + prefix;
    },

    reset,

    handle(input) {
      const { key } = input;
      if (input.meta || (input.alt && !input.altGraph)) return undefined;

      if (input.ctrl && !input.altGraph) {
        reset();
        switch (key) {
          case "d":
            return { type: "halfPage", direction: 1 };
          case "u":
            return { type: "halfPage", direction: -1 };
          case "o":
            return { type: "history", direction: -1 };
          case "i":
            return { type: "history", direction: 1 };
          default:
            return undefined;
        }
      }

      // Una secuencia pendiente consume la siguiente tecla, aunque sea un
      // dígito: `g0` no es un contador.
      if (prefix) {
        const current = prefix;
        const n = takeCount();
        reset();

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

      if (/^[0-9]$/.test(key)) {
        // `0` solo cuenta dentro de un número (`10j`); solo no es un comando.
        if (key === "0" && count === "") return undefined;
        count += key;
        return undefined;
      }

      const n = takeCount();

      switch (key) {
        case "g":
          prefix = "g";
          return undefined;
        case "]":
          prefix = "]";
          return undefined;
        case "[":
          prefix = "[";
          return undefined;
        case "j":
          reset();
          return { type: "moveBlock", count: n ?? 1 };
        case "k":
          reset();
          return { type: "moveBlock", count: -(n ?? 1) };
        case "G":
          reset();
          return { type: "bottom", count: n };
        case "/":
          reset();
          return { type: "search", direction: 1 };
        case "?":
          reset();
          return { type: "search", direction: -1 };
        case "n":
          reset();
          return { type: "nextMatch", direction: 1, count: n ?? 1 };
        case "N":
          reset();
          return { type: "nextMatch", direction: -1, count: n ?? 1 };
        case "f":
          reset();
          return { type: "hints" };
        case ":":
          reset();
          return { type: "ex" };
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
