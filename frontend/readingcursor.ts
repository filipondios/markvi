import { readingBlockIndex, type BlockBox } from "./lines.ts";

/** Estado explícito del bloque de lectura, independiente del scroll disponible. */
export interface ReadingCursor {
  readonly index: number | undefined;
  current(
    blocks: readonly BlockBox[],
    y: number,
    scrollTop: number,
    maxScroll: number,
    viewportBottom?: number,
  ): number;
  sync(
    blocks: readonly BlockBox[],
    y: number,
    scrollTop: number,
    maxScroll: number,
    viewportBottom?: number,
  ): number;
  set(index: number, length: number): number;
  move(
    delta: number,
    blocks: readonly BlockBox[],
    y: number,
    scrollTop: number,
    maxScroll: number,
    viewportBottom?: number,
  ): number;
  clear(): void;
}

export function createReadingCursor(): ReadingCursor {
  let index: number | undefined;

  const sync = (
    blocks: readonly BlockBox[],
    y: number,
    scrollTop: number,
    maxScroll: number,
    viewportBottom?: number,
  ) => {
    const next = readingBlockIndex(blocks, y, scrollTop, maxScroll, viewportBottom);
    index = next < 0 ? undefined : next;
    return next;
  };

  return {
    get index() {
      return index;
    },
    current(blocks, y, scrollTop, maxScroll, viewportBottom) {
      if (blocks.length === 0) {
        index = undefined;
        return -1;
      }
      if (index === undefined || index < 0 || index >= blocks.length) {
        return sync(blocks, y, scrollTop, maxScroll, viewportBottom);
      }
      return index;
    },
    sync,
    set(next, length) {
      if (length === 0) {
        index = undefined;
        return -1;
      }
      index = Math.min(length - 1, Math.max(0, next));
      return index;
    },
    move(delta, blocks, y, scrollTop, maxScroll, viewportBottom) {
      const current = this.current(blocks, y, scrollTop, maxScroll, viewportBottom);
      if (current < 0) return -1;
      return this.set(current + delta, blocks.length);
    },
    clear() {
      index = undefined;
    },
  };
}
