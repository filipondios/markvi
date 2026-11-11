// Tecla líder con secuencias: se pulsa la líder (`espacio`), después una o
// varias teclas. Cada acción se identifica por su secuencia, p. ej. `["f"]`
// para `espacio + f` o `["g", "t"]` para `espacio + g + t`.

export interface LeaderAction {
  /** Teclas que siguen a la líder. */
  keys: readonly string[];
  /** Texto para el panel which-key. */
  label?: string;
  run: () => void;
}

export interface LeaderOptions {
  /** Milisegundos antes de olvidar la secuencia pendiente. `0` la desactiva. */
  timeout?: number;
  /** Se llama al cancelar la secuencia (timeout, fallo o acción ejecutada). */
  onCancel?: () => void;
}

export type LeaderFeedResult = "pending" | "handled" | "miss" | "ignored";

export interface Leader {
  readonly active: boolean;
  /** Secuencia pendiente, sin la tecla líder. */
  readonly pending: readonly string[];
  start(): void;
  cancel(): void;
  /** Procesa una tecla pulsada mientras la líder está activa. */
  feed(key: string): LeaderFeedResult;
  /** Acciones que continúan la secuencia pendiente. */
  available(): readonly LeaderAction[];
}

const sameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

export function createLeader(actions: readonly LeaderAction[], options: LeaderOptions = {}): Leader {
  const timeout = options.timeout ?? 800;
  let sequence: string[] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    const wasActive = sequence !== null;
    sequence = null;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (wasActive) options.onCancel?.();
  };

  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = timeout > 0 ? setTimeout(cancel, timeout) : undefined;
  };

  return {
    get active() {
      return sequence !== null;
    },

    get pending() {
      return sequence ? [...sequence] : [];
    },

    start() {
      sequence = [];
      arm();
    },

    cancel,

    available() {
      const current = sequence;
      if (current === null) return [];
      return actions.filter(
        (action) =>
          action.keys.length > current.length &&
          sameSequence(action.keys.slice(0, current.length), current),
      );
    },

    feed(key) {
      if (sequence === null) return "ignored";
      const next = [...sequence, key];
      sequence = next;

      const exact = actions.find((action) => sameSequence(action.keys, next));
      if (exact) {
        cancel();
        exact.run();
        return "handled";
      }

      const isPrefix = actions.some(
        (action) =>
          action.keys.length > next.length &&
          sameSequence(action.keys.slice(0, next.length), next),
      );
      if (isPrefix) {
        arm();
        return "pending";
      }

      cancel();
      return "miss";
    },
  };
}
