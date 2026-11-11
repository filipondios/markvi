// Extracción de encabezados para el índice del documento. Se apoya en el lexer
// de marked y en el mapa de líneas de `lines.ts`, así que ignora los `#` que
// están dentro de bloques de código e incluye los encabezados setext.

import { Marked } from "marked";
import { annotateTokenLines, type LineToken } from "./lines.ts";

export interface Heading {
  level: number;
  text: string;
  line: number;
  endLine: number;
  /** Línea del siguiente encabezado de nivel igual o mayor, o el final. */
  sectionEnd: number;
}

type HeadingToken = LineToken & { depth?: number; text?: string };

const marked = new Marked();

export function extractHeadings(source: string): Heading[] {
  const tokens = marked.lexer(source) as unknown as HeadingToken[];
  annotateTokenLines(tokens, source);

  const headings: Heading[] = [];
  collect(tokens, headings);
  headings.sort((a, b) => a.line - b.line);

  const lineCount = source.split("\n").length;
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    let end = lineCount + 1;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next]!.level <= heading.level) {
        end = headings[next]!.line;
        break;
      }
    }
    heading.sectionEnd = end;
  }

  return headings;
}

function collect(tokens: readonly HeadingToken[], headings: Heading[]): void {
  for (const token of tokens) {
    if (token.type === "heading" && token.line !== undefined) {
      headings.push({
        level: token.depth ?? 1,
        text: plainText(token.text ?? ""),
        line: token.line,
        endLine: token.endLine ?? token.line,
        sectionEnd: 0,
      });
    }
    if (token.tokens) collect(token.tokens as HeadingToken[], headings);
    if (token.items) collect(token.items as HeadingToken[], headings);
  }
}

/** Texto legible de un encabezado: quita enlaces, imágenes, código y énfasis. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
