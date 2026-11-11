// Serialización y validación de las pestañas guardadas en `localStorage`.
// El contenido de localStorage puede estar corrupto o ser antiguo, así que se
// comprueba todo antes de confiar en él.

export type TabMode = "view" | "edit";

export interface StoredTab {
  path: string;
  mode: TabMode;
}

export function isSafePath(path: string) {
  if (!path.toLowerCase().endsWith(".md")) return false;
  if (path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== ".." && !segment.startsWith("."));
}

export function parseStoredTabs(raw: string | null): StoredTab[] {
  if (!raw) return [];

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!stored || typeof stored !== "object") return [];

  const entries = (stored as { tabs?: unknown }).tabs;
  if (!Array.isArray(entries)) return [];

  const result: StoredTab[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { path, mode } = entry as { path?: unknown; mode?: unknown };
    if (typeof path !== "string" || !isSafePath(path) || seen.has(path)) continue;
    seen.add(path);
    result.push({ path, mode: mode === "edit" ? "edit" : "view" });
  }

  return result;
}

export function serializeTabs(tabs: readonly StoredTab[]) {
  return JSON.stringify({ tabs });
}

/** Etiquetas de pestaña: el sufijo más corto que no se repita entre rutas. */
export function tabLabels(paths: readonly string[]): string[] {
  const parts = paths.map((path) => path.split("/"));
  return parts.map((segments, index) => {
    for (let depth = 1; depth <= segments.length; depth++) {
      const candidate = segments.slice(-depth).join("/");
      const unique = parts.every(
        (other, otherIndex) =>
          otherIndex === index || other.slice(-depth).join("/") !== candidate,
      );
      if (unique) return candidate;
    }
    return segments.join("/");
  });
}
