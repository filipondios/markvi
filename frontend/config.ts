// Configuración del usuario (`config.toml`): la valida el servidor y aquí solo se
// pide y se aplica. Si la petición falla, la app arranca con los valores de serie.

import { defaultConfig, type Config, type LoadedConfig } from "./shared/configdefaults.ts";
import { CONFIG_URL } from "./shared/paths.ts";

export type { Config };

declare global {
  interface Window {
    /** Peticiones lanzadas por el script de arranque de index.html. */
    __boot?: { t: number; r: Record<string, Promise<Response> | undefined> };
  }
}

// Una petición temprana solo vale si se recoge al arrancar: pasado este tiempo la
// respuesta podría ser vieja.
const EARLY_MAX_AGE = 10_000;

/** Recoge (una sola vez) la petición que index.html lanzó antes de cargar el bundle. */
export function takeEarly(url: string): Promise<Response> | undefined {
  const boot = window.__boot;
  const request = boot?.r[url];
  if (!boot || !request) return undefined;
  delete boot.r[url];
  return Date.now() - boot.t <= EARLY_MAX_AGE ? request : undefined;
}

export async function loadClientConfig(): Promise<LoadedConfig> {
  try {
    const response = await (takeEarly(CONFIG_URL) ?? fetch(CONFIG_URL, { cache: "no-store" }));
    if (!response.ok) throw new Error(`Error ${response.status}`);
    return (await response.json()) as LoadedConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: defaultConfig(),
      warnings: [`Could not load the configuration: ${message}`],
      path: "",
      exists: false,
    };
  }
}

/** Tema y fuente: variables y atributos del <html>. */
export function applyAppearance(config: Config) {
  const root = document.documentElement;
  if (config.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = config.theme;

  // La fuente propia va primero; si no está instalada cae a la de serie.
  if (config.font) {
    root.style.setProperty("--font-mono", `${config.font}, "Obel Mono", ui-monospace, monospace`);
  }
}

/** ¿Tema oscuro ahora? `auto` sigue al sistema. */
export function isDark(config: Config, systemDark: boolean) {
  return config.theme === "dark" || (config.theme === "auto" && systemDark);
}

/** Nombre legible de una tecla para el panel which-key. */
export function keyLabel(key: string) {
  return key === " " ? "space" : key;
}
