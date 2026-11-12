// Configuración del usuario (`config.toml`): la valida el servidor y aquí solo se
// pide y se aplica. Si la petición falla, la app arranca con los valores de serie.

import { defaultConfig, type Config, type LoadedConfig } from "../src/configdefaults.ts";

export type { Config };

export async function loadClientConfig(): Promise<LoadedConfig> {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
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
