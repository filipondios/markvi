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

export const VIM_CONTEXTS = ["normal", "insert", "visual"] as const;
export type VimContext = (typeof VIM_CONTEXTS)[number];
export const KEYMAP_SECTIONS = ["leader", "view", ...VIM_CONTEXTS] as const;
export const CONFIG_SECTIONS = ["leader", "theme", "font", "editor", "keymap", "render"] as const;

export interface VimMapping {
  context: VimContext;
  lhs: string;
  rhs: string;
}

export interface EditorOptions {
  number: boolean;
  relativenumber: boolean;
  scrolloff: number;
}

export const DEFAULT_EDITOR: EditorOptions = {
  number: true,
  relativenumber: false,
  scrolloff: 0,
};

export interface Config {
  /** Tecla líder (valor de `KeyboardEvent.key`). */
  leader: string;
  theme: Theme;
  /** Valor CSS de `font-family` para el texto monoespaciado, o `null` para el de serie. */
  font: string | null;
  editor: EditorOptions;
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
  /**
   * Cargar imágenes (y otros recursos) de otros sitios. Desactivado por omisión:
   * un `.md` ajeno no debe poder hacer peticiones externas (rastreo, IP) al abrirse.
   */
  remoteimages: boolean;
}

export interface LoadedConfig {
  config: Config;
  warnings: string[];
  path: string;
  exists: boolean;
}

export const RENDER_EXTRAS = ["footnotes", "alerts", "frontmatter", "remoteimages"] as const satisfies readonly (keyof RenderExtras)[];

export const DEFAULT_LEADER_BINDINGS: readonly LeaderBinding[] = [
  { keys: ["f"], action: "find" },
  { keys: ["/"], action: "grep" },
  { keys: ["r"], action: "recent" },
  { keys: ["a"], action: "alternate" },
  { keys: ["t"], action: "toc" },
  { keys: ["b"], action: "backlinks" },
  { keys: ["x"], action: "close" },
];

/** Extras que empiezan desactivados porque abren una superficie de ataque. */
const OFF_BY_DEFAULT: readonly (keyof RenderExtras)[] = ["remoteimages"];

function defaultRenderExtras(): RenderExtras {
  const extras = {} as RenderExtras;
  for (const key of RENDER_EXTRAS) extras[key] = !OFF_BY_DEFAULT.includes(key);
  return extras;
}

export function defaultConfig(): Config {
  return {
    leader: " ",
    theme: "auto",
    font: null,
    editor: { ...DEFAULT_EDITOR },
    leaderBindings: DEFAULT_LEADER_BINDINGS.map((binding) => ({
      keys: [...binding.keys],
      action: binding.action,
    })),
    viewRemap: {},
    vimMappings: [],
    render: defaultRenderExtras(),
  };
}
