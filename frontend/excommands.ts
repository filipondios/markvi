// Vocabulario de comandos ex compartido por el editor Vim y la vista: los
// alias, el nombre canónico y el `!` de fuerza viven aquí una sola vez.

export const FILE_COMMANDS = ["edit", "mv", "rm"] as const;
export type FileCommandName = (typeof FILE_COMMANDS)[number];

export interface FileCommand {
  name: FileCommandName;
  /** Argumento sin el `!` inicial ni espacios. */
  arg: string;
  /** Se escribió `!` (p. ej. `:rm!`, `:e! nuevo`). */
  force: boolean;
}

export const EX_ALIASES: Record<string, string> = {
  e: "edit",
  edit: "edit",
  mv: "mv",
  move: "mv",
  rename: "mv",
  rm: "rm",
  delete: "rm",
  remove: "rm",
  q: "quit",
  quit: "quit",
  w: "write",
  write: "write",
  wq: "wq",
  x: "wq",
  config: "config",
};

/** `!` al principio o al final del argumento (`:rm!`, `:e nuevo!`). */
export function parseForce(raw: string): { force: boolean; argument: string } {
  const text = raw.trim();
  const leading = text.startsWith("!");
  const trailing = text.endsWith("!");
  let argument = leading ? text.slice(1).trim() : text;
  if (!leading && trailing) argument = argument.slice(0, -1).trim();
  return { force: leading || trailing, argument };
}

export interface ParsedEx {
  name: string;
  argument: string;
  force: boolean;
}

export function parseExCommand(input: string): ParsedEx | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  const word = first.replace(/!$/, "").toLowerCase();
  const name = EX_ALIASES[word];
  if (!name) return undefined;

  const { force, argument } = parseForce(trimmed.slice(first.length));
  return { name, argument, force: force || first.endsWith("!") };
}
