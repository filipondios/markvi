import { normalizeNewPath } from "./newfile.ts";
import { renderMarkdown } from "./render.ts";
import { createSelector, highlight, type Selector } from "./selector.ts";

export interface FinderOptions {
  /** Lista actual de archivos `.md` (el orden se respeta si no hay consulta). */
  list: () => Promise<string[]>;
  /** Contenido crudo de un archivo, para la vista previa. */
  read: (path: string) => Promise<string>;
  /** Abre el archivo elegido con `Enter`. */
  open: (path: string) => void;
  /** Si se indica, sin coincidencias se ofrece crear el archivo con ese nombre. */
  create?: (path: string) => void;
  title?: string;
  placeholder?: string;
  listLabel?: string;
  emptyText?: string;
}

export type Finder = Selector;

interface Entry {
  path: string;
  /** Fila «crear archivo»: el archivo aún no existe. */
  create?: boolean;
}

export function createFinder(options: FinderOptions): Finder {
  return createSelector<Entry>({
    title: options.title ?? "Find file",
    placeholder: options.placeholder ?? "Find file…",
    listLabel: options.listLabel ?? "Files",
    hint: options.create
      ? "↑↓ or Ctrl+j/k move · Enter open or create · Esc close"
      : "↑↓ or Ctrl+j/k move · Enter open · Esc close",
    empty: (query) => (query ? "No results." : (options.emptyText ?? "No .md files.")),
    async items() {
      return (await options.list()).map((path) => ({
        key: path,
        label: path,
        data: { path },
      }));
    },
    fallback(query) {
      if (!options.create) return undefined;
      const path = normalizeNewPath(query);
      if (!path) return undefined;
      return { key: `\0create:${path}`, label: path, data: { path, create: true } };
    },
    renderItem(item, positions) {
      const { path, create } = item.data;
      const slash = path.lastIndexOf("/");
      const split = slash + 1;
      const dir = path.slice(0, split);
      const name = path.slice(split);
      const fragment = document.createDocumentFragment();

      if (create) {
        const badge = document.createElement("span");
        badge.className = "finder-create";
        badge.textContent = "Create";
        fragment.append(badge);
      }

      if (dir) {
        const dirNode = document.createElement("span");
        dirNode.className = "finder-dir";
        dirNode.append(highlight(dir, positions.filter((position) => position < split)));
        fragment.append(dirNode);
      }

      const nameNode = document.createElement("span");
      nameNode.className = "finder-name";
      nameNode.append(
        highlight(
          name,
          positions.filter((position) => position >= split).map((position) => position - split),
        ),
      );
      fragment.append(nameNode);
      return fragment;
    },
    preview(item) {
      if (item.data.create) return `New file: ${item.data.path}`;
      return options.read(item.data.path).then((source) => renderMarkdown(source, item.data.path));
    },
    previewTitle(item) {
      return item.data.create ? `${item.data.path} (new)` : item.data.path;
    },
    choose(item) {
      if (item.data.create) options.create?.(item.data.path);
      else options.open(item.data.path);
    },
    count(shown, total) {
      return total > 0 ? `${shown}/${total}` : "";
    },
  });
}
