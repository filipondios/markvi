// Nombre de un archivo nuevo escrito por el usuario (`:e notas/idea`, buscador).
// Devuelve la ruta relativa normalizada o `null` si no se puede crear.

import { isSafePath } from "./tabstore.ts";

export function normalizeNewPath(input: string): string | null {
  let path = input.trim().replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!path) return null;
  if (!path.toLowerCase().endsWith(".md")) path += ".md";
  // Caracteres de control: el sistema de archivos los admite, la URL no los quiere.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return isSafePath(path) ? path : null;
}
