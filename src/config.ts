// Configuración del usuario: `~/.config/markvi/config.toml` (o la ruta de
// `--config` / `MARKVI_CONFIG`). Se lee en cada petición de `/api/config`, así que
// basta con recargar la página para aplicar los cambios.
//
// Todo lo que viene del archivo se valida aquí: un valor no válido se ignora con
// un aviso y nunca impide arrancar. El cliente recibe la configuración ya
// resuelta (valores por omisión y atajos fusionados).

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_LEADER_BINDINGS,
  LEADER_ACTIONS,
  defaultConfig,
  type Config,
  type LeaderBinding,
  type LoadedConfig,
  type VimContext,
} from "./configdefaults.ts";

export * from "./configdefaults.ts";

export function resolveConfigPath(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  if (flag) return resolve(flag);
  if (env.MARKVI_CONFIG) return resolve(env.MARKVI_CONFIG);
  const base =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "markvi", "config.toml");
}

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_SEQUENCE = 4;
const MAX_MAPPING = 64;
const GENERIC_FONTS = new Set(["monospace", "ui-monospace", "sans-serif", "serif", "system-ui"]);

/** Una tecla: un carácter visible, o `space`. */
function parseKey(token: string): string | null {
  if (token.toLowerCase() === "space") return " ";
  const chars = Array.from(token);
  return chars.length === 1 && !/\s/.test(token) ? token : null;
}

/** `"f"`, `"gt"` (g y luego t) o `"g t"`; `space` es la barra espaciadora. */
export function parseSequence(input: string): string[] | null {
  const text = input.trim();
  if (!text) return null;
  if (text.toLowerCase() === "space") return [" "];

  const tokens = /\s/.test(text) ? text.split(/\s+/) : Array.from(text);
  if (tokens.length > MAX_SEQUENCE) return null;

  const keys: string[] = [];
  for (const token of tokens) {
    const key = parseKey(token);
    if (key === null) return null;
    keys.push(key);
  }
  return keys;
}

/** Valor CSS de `font-family` a partir de `"JetBrains Mono, Fira Code"`. */
export function parseFont(input: string): string | null {
  const names = input
    .split(",")
    .map((name) => name.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
    .filter(Boolean);
  if (names.length === 0 || names.length > 8) return null;

  const css: string[] = [];
  for (const name of names) {
    if (GENERIC_FONTS.has(name.toLowerCase())) css.push(name.toLowerCase());
    else if (/^[\p{L}\p{N} _.-]{1,60}$/u.test(name)) css.push(`"${name}"`);
    else return null;
  }
  return css.join(", ");
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

const isPrefix = (shorter: readonly string[], longer: readonly string[]) =>
  shorter.length < longer.length && shorter.every((key, index) => key === longer[index]);

/** Valida el contenido ya leído del TOML. Nunca lanza: lo inválido se ignora con aviso. */
export function validateConfig(raw: unknown): { config: Config; warnings: string[] } {
  const config = defaultConfig();
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  if (!isTable(raw)) {
    warn("The configuration must be a TOML table.");
    return { config, warnings };
  }

  const known = new Set(["leader", "theme", "font", "editor", "keymap"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) warn(`Unknown key "${key}".`);
  }

  // --- leader ---------------------------------------------------------------
  if (raw.leader !== undefined) {
    const key = typeof raw.leader === "string" ? parseKey(raw.leader) : null;
    // Una letra o un dígito chocaría con la navegación de la vista y con el texto.
    if (key === null || /^[\p{L}\p{N}]$/u.test(key)) {
      warn(`"leader" must be "space" or a single symbol such as "," (got ${JSON.stringify(raw.leader)}).`);
    } else {
      config.leader = key;
    }
  }

  // --- theme ----------------------------------------------------------------
  if (raw.theme !== undefined) {
    if (raw.theme === "auto" || raw.theme === "light" || raw.theme === "dark") {
      config.theme = raw.theme;
    } else {
      warn(`"theme" must be "auto", "light" or "dark" (got ${JSON.stringify(raw.theme)}).`);
    }
  }

  // --- font -----------------------------------------------------------------
  if (raw.font !== undefined) {
    const font = typeof raw.font === "string" ? parseFont(raw.font) : null;
    if (font === null) warn(`"font" must be a list of font names such as "JetBrains Mono, monospace".`);
    else config.font = font;
  }

  // --- [editor] -------------------------------------------------------------
  if (raw.editor !== undefined) {
    if (!isTable(raw.editor)) {
      warn(`"editor" must be a table.`);
    } else {
      for (const [key, value] of Object.entries(raw.editor)) {
        if (key === "number" || key === "relativenumber") {
          if (typeof value === "boolean") config.editor[key] = value;
          else warn(`"editor.${key}" must be true or false.`);
        } else if (key === "scrolloff") {
          if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 50) {
            config.editor.scrolloff = value;
          } else {
            warn(`"editor.scrolloff" must be an integer between 0 and 50.`);
          }
        } else {
          warn(`Unknown key "editor.${key}".`);
        }
      }
    }
  }

  // --- [keymap.*] -----------------------------------------------------------
  const keymap = raw.keymap;
  if (keymap !== undefined && !isTable(keymap)) {
    warn(`"keymap" must be a table.`);
  } else if (keymap !== undefined) {
    const sections = new Set(["leader", "view", "normal", "insert", "visual"]);
    for (const [name, table] of Object.entries(keymap)) {
      if (!sections.has(name)) {
        warn(`Unknown section "keymap.${name}".`);
      } else if (!isTable(table)) {
        warn(`"keymap.${name}" must be a table.`);
      }
    }

    applyLeader(config, keymap.leader, warn);
    applyViewRemap(config, keymap.view, warn);
    for (const context of ["normal", "insert", "visual"] as const) {
      applyVimMappings(config, context, keymap[context], warn);
    }
  }

  return { config, warnings };
}

function applyLeader(config: Config, table: unknown, warn: (message: string) => void) {
  if (!isTable(table)) return;

  const bindings = config.leaderBindings;
  const userDefined: LeaderBinding[] = [];

  for (const [sequence, value] of Object.entries(table)) {
    const keys = parseSequence(sequence);
    if (keys === null) {
      warn(`keymap.leader: invalid key sequence ${JSON.stringify(sequence)}.`);
      continue;
    }

    const index = bindings.findIndex((binding) => sameKeys(binding.keys, keys));
    if (value === "none" || value === "") {
      if (index >= 0) bindings.splice(index, 1);
      continue;
    }

    const valid =
      typeof value === "string" &&
      ((LEADER_ACTIONS as readonly string[]).includes(value) ||
        (value.startsWith(":") && value.slice(1).trim().length > 0 && value.length <= 200));
    if (!valid) {
      warn(
        `keymap.leader.${sequence}: unknown action ${JSON.stringify(value)}. ` +
          `Use ${LEADER_ACTIONS.join(", ")}, "none" or an ex command such as ":e diary.md".`,
      );
      continue;
    }

    const binding = { keys, action: value as string };
    if (index >= 0) bindings[index] = binding;
    else bindings.push(binding);
    userDefined.push(binding);
  }

  // Una secuencia que es prefijo de otra la taparía (la más corta se ejecuta
  // antes que la tecla siguiente): se descarta la larga y se avisa.
  for (const binding of [...bindings]) {
    const blocker = bindings.find((other) => isPrefix(other.keys, binding.keys));
    if (!blocker) continue;
    bindings.splice(bindings.indexOf(binding), 1);
    if (userDefined.includes(binding)) {
      warn(
        `keymap.leader: "${binding.keys.join(" ")}" is ignored because "${blocker.keys.join(" ")}" is already bound. ` +
          `Unbind it with "${blocker.keys.join(" ")}" = "none".`,
      );
    }
  }
}

function applyViewRemap(config: Config, table: unknown, warn: (message: string) => void) {
  if (!isTable(table)) return;

  for (const [from, value] of Object.entries(table)) {
    const source = parseKey(from);
    const target = typeof value === "string" ? parseKey(value) : null;
    if (source === null || target === null || source === " " || target === " ") {
      warn(`keymap.view: ${JSON.stringify(from)} = ${JSON.stringify(value)} must map one key to another key.`);
      continue;
    }
    if (source !== target) config.viewRemap[source] = target;
  }
}

function applyVimMappings(
  config: Config,
  context: VimContext,
  table: unknown,
  warn: (message: string) => void,
) {
  if (!isTable(table)) return;

  for (const [lhs, rhs] of Object.entries(table)) {
    if (
      !lhs ||
      lhs.length > MAX_MAPPING ||
      typeof rhs !== "string" ||
      !rhs ||
      rhs.length > MAX_MAPPING
    ) {
      warn(`keymap.${context}: ${JSON.stringify(lhs)} = ${JSON.stringify(rhs)} is not a valid mapping.`);
      continue;
    }
    config.vimMappings.push({ context, lhs, rhs });
  }
}

/** Interpreta el texto del archivo; `null` significa que no existe. */
export function parseConfig(text: string | null): { config: Config; warnings: string[] } {
  if (text === null || !text.trim()) return { config: defaultConfig(), warnings: [] };

  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: defaultConfig(), warnings: [`Syntax error: ${message}`] };
  }
  return validateConfig(raw);
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { config: defaultConfig(), warnings: [], path, exists: false };
  }

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: defaultConfig(),
      warnings: [`Could not read the file: ${message}`],
      path,
      exists: true,
    };
  }

  const { config, warnings } = parseConfig(text);
  return { config, warnings, path, exists: true };
}
