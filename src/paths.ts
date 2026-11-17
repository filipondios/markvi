// Convenciones de rutas de MarkVi. Sin Node ni DOM: las usan el servidor y el
// navegador. Todas las rutas relativas son POSIX, sin `./` ni `/` inicial.

export const VIEW_PREFIX = "/view/";
export const FILES_PREFIX = "/files/";
export const CONFIG_URL = "/api/config";
export const TREE_URL = "/api/tree";
export const FILES_URL = "/api/file";
export const MOVE_URL = "/api/move";
export const SEARCH_URL = "/api/search";
export const BACKLINKS_URL = "/api/backlinks";
export const EVENTS_URL = "/api/events";

/** Ruta tolerante de la API: sanea separadores y prefijos. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** Ruta estricta para entrada del usuario o `localStorage`. */
export function isSafePath(path: string): boolean {
  if (!isMarkdownPath(path)) return false;
  if (path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== ".." && !segment.startsWith("."));
}

/** Nombre de archivo escrito por el usuario: ruta estricta con `.md` implícita. */
export function normalizeNewPath(input: string): string | null {
  let path = input.trim().replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!path) return null;
  if (!isMarkdownPath(path)) path += ".md";
  // Caracteres de control: el sistema de archivos los admite, la URL no los quiere.
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return isSafePath(path) ? path : null;
}

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

export const viewUrl = (path: string) =>
  VIEW_PREFIX + path.split("/").map(encodeURIComponent).join("/");

export const fileUrl = (path: string) => `${FILES_URL}?path=${encodeURIComponent(path)}`;
