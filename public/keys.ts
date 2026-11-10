// Tecla líder con secuencias: se pulsa la líder (`espacio`), después una o
// varias teclas. Cada acción se identifica por su secuencia, p. ej. `["f"]`
// para `espacio + f` o `["g", "t"]` para `espacio + g + t`.

export interface LeaderAction {
  /** Teclas que siguen a la líder. */
  keys: readonly string[];
  run: () => void;
}

export interface LeaderOptions {
  /** Milisegundos antes de olvidar la secuencia pendiente. `0` la desactiva. */
  timeout?: number;
}

export type LeaderFeedResult = "pending" | "handled" | "miss" | "ignored";

export interface Leader {
  readonly active: boolean;
  start(): void;
  cancel(): void;
  /** Procesa una tecla pulsada mientras la líder está activa. */
  feed(key: string): LeaderFeedResult;
}

const sameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

export function createLeader(actions: readonly LeaderAction[], options: LeaderOptions = {}): Leader {
  const timeout = options.timeout ?? 800;
  let pending: string[] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    pending = null;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = timeout > 0 ? setTimeout(cancel, timeout) : undefined;
  };

  return {
    get active() {
      return pending !== null;
    },

    start() {
      pending = [];
      arm();
    },

    cancel,

    feed(key) {
      if (pending === null) return "ignored";
      const sequence = [...pending, key];
      pending = sequence;

      const exact = actions.find((action) => sameSequence(action.keys, sequence));
      if (exact) {
        cancel();
        exact.run();
        return "handled";
      }

      const isPrefix = actions.some(
        (action) =>
          action.keys.length > sequence.length &&
          sameSequence(action.keys.slice(0, sequence.length), sequence),
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
