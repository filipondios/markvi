import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { isIgnored, isMarkdown } from "./files.ts";

export type DiskEventType = "change" | "delete";

export interface DiskEvent {
  type: DiskEventType;
  path: string;
}

export type DiskListener = (event: DiskEvent) => void;

export interface FileWatcher {
  subscribe(listener: DiskListener): () => void;
  close(): void;
}

// Los editores y algunos sistemas de archivos emiten varios eventos por una
// sola escritura (`rename` + `change`); se agrupan por ruta antes de avisar.
const DEBOUNCE_MS = 80;

export function createFileWatcher(root: string): FileWatcher {
  const listeners = new Set<DiskListener>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: FSWatcher | undefined;

  const emit = (event: DiskEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Un cliente roto no debe impedir avisar al resto.
      }
    }
  };

  const schedule = (path: string) => {
    if (!isMarkdown(path)) return;
    // La API nunca sirve estas rutas (.git, node_modules, ocultos): no hay que
    // hacer stat ni avisar a los clientes por cada README de una dependencia.
    if (path.split("/").some(isIgnored)) return;

    const previous = timers.get(path);
    if (previous) clearTimeout(previous);

    timers.set(
      path,
      setTimeout(async () => {
        timers.delete(path);
        const info = await stat(join(root, path)).catch(() => null);
        emit({ type: info?.isFile() ? "change" : "delete", path });
      }, DEBOUNCE_MS),
    );
  };

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      schedule(filename.toString().split(sep).join("/"));
    });
    watcher.on("error", (error) => console.error("File watcher:", error));
  } catch (error) {
    console.error("Could not watch the directory:", error);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      listeners.clear();
      watcher?.close();
      watcher = undefined;
    },
  };
}
