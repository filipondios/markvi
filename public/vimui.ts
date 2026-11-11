// Texto de la barra de estado para el editor Vim. Se separa de CodeMirror para
// poder probarlo sin DOM.

export interface VimStatus {
  /** Modo que reporta la librería: normal, insert, visual, visual line… */
  mode: string;
  /** Comando a medias, p. ej. `d`, `2` o `"a`. */
  pending: string;
  /** Registro de la macro que se está grabando, si hay alguna. */
  recording?: string;
}

export function vimModeLabel(mode: string): string {
  switch (mode) {
    case "normal":
      return "NORMAL";
    case "insert":
      return "INSERT";
    case "replace":
      return "REPLACE";
    case "visual":
      return "VISUAL";
    case "visual line":
      return "V-LINE";
    case "visual block":
      return "V-BLOCK";
    default:
      return mode.toUpperCase();
  }
}

export function vimStatusText(status: VimStatus): string {
  return [status.pending, status.recording && `recording @${status.recording}`]
    .filter(Boolean)
    .join(" ");
}
