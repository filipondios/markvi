// Mecánica común de las máquinas de teclado estilo Vim: modificadores y
// contador/prefix. La usan la vista del documento y la portada.

export interface ViewKey {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  /** AltGr: en algunas distribuciones produce `]`, `[`, `{`… */
  altGraph?: boolean;
}

/** AltGr llega como Ctrl+Alt: no debe confundirse con un modificador puro. */
export const altGraph = (event: KeyboardEvent) => event.getModifierState?.("AltGraph") ?? false;

export function isPlainKey(input: ViewKey): boolean {
  return !input.meta && !(input.alt && !input.altGraph);
}

export function isPlainControl(input: ViewKey): boolean {
  return !!input.ctrl && !input.altGraph;
}

export function hasPlainModifier(event: KeyboardEvent): boolean {
  return !isPlainKey({
    key: event.key,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    altGraph: altGraph(event),
  });
}

export function viewKeyOf(event: KeyboardEvent, key = event.key): ViewKey {
  return {
    key,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    altGraph: altGraph(event),
  };
}

export interface CountState {
  readonly pending: string;
  readonly prefix: string;
  take(): number | undefined;
  reset(): void;
  setPrefix(prefix: string): void;
  /** Consume la tecla si es un dígito; `0` inicial se ignora como en Vim. */
  digit(key: string): boolean;
}

export function createCountState(): CountState {
  let count = "";
  let prefix = "";

  return {
    get pending() {
      return count + prefix;
    },
    get prefix() {
      return prefix;
    },
    take: () => (count ? Number(count) : undefined),
    reset() {
      count = "";
      prefix = "";
    },
    setPrefix(value) {
      prefix = value;
    },
    digit(key) {
      if (!/^[0-9]$/.test(key)) return false;
      if (key === "0" && count === "") return true;
      count += key;
      return true;
    },
  };
}
