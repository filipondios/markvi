// Tipos y valores por omisión de la configuración. No importa nada de Node ni de
// Bun: el cliente (navegador) los comparte con el servidor.

export type Theme = "auto" | "light" | "dark";

/** Acciones de la tecla líder. Un valor que empieza por `:` ejecuta ese comando ex. */
export const LEADER_ACTIONS = [
  "find",
  "grep",
  "recent",
  "alternate",
  "toc",
  "backlinks",
  "close",
] as const;
export type LeaderAction = (typeof LEADER_ACTIONS)[number];

export interface LeaderBinding {
  /** Teclas que siguen a la líder, p. ej. `["f"]`. */
  keys: string[];
  /** Una de `LEADER_ACTIONS` o un comando ex (`:e diario.md`). */
  action: string;
}

export type VimContext = "normal" | "insert" | "visual";

export interface VimMapping {
  context: VimContext;
  lhs: string;
  rhs: string;
}

export interface Config {
  /** Tecla líder (valor de `KeyboardEvent.key`). */
  leader: string;
  theme: Theme;
  /** Valor CSS de `font-family` para el texto monoespaciado, o `null` para el de serie. */
  font: string | null;
  editor: {
    number: boolean;
    relativenumber: boolean;
    scrolloff: number;
  };
  /** Atajos de la líder, ya fusionados con los de serie. */
  leaderBindings: LeaderBinding[];
  /** Tecla pulsada → tecla que recibe la vista renderizada. */
  viewRemap: Record<string, string>;
  /** Mapeos del editor (`Vim.map`). */
  vimMappings: VimMapping[];
  /** Extras de render opcionales, activados por omisión. */
  render: RenderExtras;
}

export interface RenderExtras {
  /** Notas al pie GFM (`[^1]` → referencia y sección de notas). */
  footnotes: boolean;
  /** Alertas de GitHub (`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`). */
  alerts: boolean;
  /** Front matter YAML inicial (`--- … ---`): se separa y no se renderiza. */
  frontmatter: boolean;
}

export interface LoadedConfig {
  config: Config;
  warnings: string[];
  path: string;
  exists: boolean;
}

export const DEFAULT_LEADER_BINDINGS: readonly LeaderBinding[] = [
  { keys: ["f"], action: "find" },
  { keys: ["/"], action: "grep" },
  { keys: ["r"], action: "recent" },
  { keys: ["a"], action: "alternate" },
  { keys: ["t"], action: "toc" },
  { keys: ["b"], action: "backlinks" },
  { keys: ["x"], action: "close" },
];

export function defaultConfig(): Config {
  return {
    leader: " ",
    theme: "auto",
    font: null,
    editor: { number: true, relativenumber: false, scrolloff: 0 },
    leaderBindings: DEFAULT_LEADER_BINDINGS.map((binding) => ({
      keys: [...binding.keys],
      action: binding.action,
    })),
    viewRemap: {},
    vimMappings: [],
    render: { footnotes: true, alerts: true, frontmatter: true },
  };
}
