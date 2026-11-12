import { renderMarkdown } from "./render.ts";
import { createSelector, highlight, type Selector } from "./selector.ts";

export interface FinderOptions {
  /** Lista actual de archivos `.md` del directorio raíz. */
  list: () => Promise<string[]>;
  /** Contenido crudo de un archivo, para la vista previa. */
  read: (path: string) => Promise<string>;
  /** Abre el archivo elegido con `Enter`. */
  open: (path: string) => void;
}

export type Finder = Selector;

export function createFinder(options: FinderOptions): Finder {
  return createSelector<string>({
    title: "Find file",
    placeholder: "Find file…",
    listLabel: "Files",
    hint: "↑↓ or Ctrl+j/k move · Enter open · Esc close",
    empty: (query) => (query ? "No results." : "No .md files."),
    async items() {
      return (await options.list()).map((path) => ({
        key: path,
        label: path,
        data: path,
      }));
    },
    renderItem(item, positions) {
      const path = item.data;
      const slash = path.lastIndexOf("/");
      const split = slash + 1;
      const dir = path.slice(0, split);
      const name = path.slice(split);
      const fragment = document.createDocumentFragment();

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
      return options.read(item.data).then((source) => renderMarkdown(source, item.data));
    },
    previewTitle(item) {
      return item.data;
    },
    choose(item) {
      options.open(item.data);
    },
    count(shown, total) {
      return total > 0 ? `${shown}/${total}` : "";
    },
  });
}
