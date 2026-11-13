import { expect, test } from "bun:test";
import { Marked } from "marked";
import {
  annotateTokenLines,
  interpolateLine,
  lineAtOffset,
  lineStarts,
  pickBlockIndex,
  sourceLineAt,
  splitFrontMatter,
  type LineToken,
} from "./lines.ts";

const lex = (source: string) =>
  new Marked().lexer(source) as unknown as LineToken[];

test("calcula posiciones de línea con LF y CRLF", () => {
  expect(lineStarts("a\nb\nc")).toEqual([0, 2, 4]);
  expect(lineAtOffset(lineStarts("a\nb\nc"), 0)).toBe(1);
  expect(lineAtOffset(lineStarts("a\nb\nc"), 2)).toBe(2);
  expect(lineAtOffset(lineStarts("a\nb\nc"), 4)).toBe(3);
  expect(lineStarts("a\r\nb\r\n")).toEqual([0, 3, 6]);
  expect(lineAtOffset(lineStarts("a\r\nb\r\n"), 4)).toBe(2);
});

test("anota bloques, listas anidadas, citas, código y tablas", () => {
  const source = `# Título

Párrafo uno
con dos líneas.

- item a
- item b
  - anidado

> cita
> dos

\`\`\`ts
const x = 1;
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

---

<div>html</div>
`;
  const tokens = lex(source);
  annotateTokenLines(tokens, source);

  const heading = tokens.find((token) => token.type === "heading");
  expect([heading?.line, heading?.endLine]).toEqual([1, 1]);

  const paragraph = tokens.find((token) => token.type === "paragraph");
  expect([paragraph?.line, paragraph?.endLine]).toEqual([3, 4]);

  const list = tokens.find((token) => token.type === "list");
  expect([list?.line, list?.endLine]).toEqual([6, 8]);
  expect(list?.items?.map((item) => [item.line, item.endLine])).toEqual([
    [6, 6],
    [7, 8],
  ]);
  expect(list?.items?.[1]?.tokens?.[1]?.type).toBe("list");
  expect([
    list?.items?.[1]?.tokens?.[1]?.line,
    list?.items?.[1]?.tokens?.[1]?.endLine,
  ]).toEqual([8, 8]);

  const quote = tokens.find((token) => token.type === "blockquote");
  expect([quote?.line, quote?.endLine]).toEqual([10, 11]);

  const code = tokens.find((token) => token.type === "code");
  expect([code?.line, code?.endLine]).toEqual([13, 15]);

  const table = tokens.find((token) => token.type === "table");
  expect([table?.line, table?.endLine]).toEqual([17, 19]);

  const hr = tokens.find((token) => token.type === "hr");
  expect([hr?.line, hr?.endLine]).toEqual([21, 21]);

  const html = tokens.find((token) => token.type === "html");
  expect([html?.line, html?.endLine]).toEqual([23, 23]);
});

test("anota listas anidadas dentro de una lista larga", () => {
  const source = `- uno
  - dos
    - tres
- cuatro
`;
  const tokens = lex(source);
  annotateTokenLines(tokens, source);
  const list = tokens[0]!;
  expect([list.line, list.endLine]).toEqual([1, 4]);
  expect([list.items?.[0]?.line, list.items?.[0]?.endLine]).toEqual([1, 3]);
  const nested = list.items?.[0]?.tokens?.find((token) => token.type === "list");
  expect([nested?.line, nested?.endLine]).toEqual([2, 3]);
  expect([nested?.items?.[0]?.line, nested?.items?.[0]?.endLine]).toEqual([2, 3]);
  expect([
    list.items?.[1]?.line,
    list.items?.[1]?.endLine,
  ]).toEqual([4, 4]);
});

test("elige el bloque correcto arriba, abajo, en un hueco y sin mapa", () => {
  const blocks = [
    { line: 1, endLine: 2, top: 0, bottom: 20 },
    { line: 10, endLine: 20, top: 30, bottom: 100 },
  ];

  expect(sourceLineAt([], 0)).toBeUndefined();
  expect(sourceLineAt(blocks, -10)).toBe(1);
  expect(sourceLineAt(blocks, 5)).toBe(1);
  expect(sourceLineAt(blocks, 25)).toBe(2);
  expect(sourceLineAt(blocks, 65)).toBe(15);
  expect(sourceLineAt(blocks, 200)).toBe(20);
  expect(pickBlockIndex(blocks, 65)).toBe(1);
});

test("interpola la línea y recorta fuera del bloque", () => {
  const block = { line: 10, endLine: 20, top: 100, bottom: 200 };
  expect(interpolateLine(block, 100)).toBe(10);
  expect(interpolateLine(block, 150)).toBe(15);
  expect(interpolateLine(block, 200)).toBe(20);
  expect(interpolateLine(block, 50)).toBe(10);
  expect(interpolateLine(block, 300)).toBe(20);
  expect(interpolateLine({ ...block, bottom: 100 }, 150)).toBe(10);
});

test("el bloque anidado gana al contenedor en la misma altura", () => {
  const blocks = [
    { line: 1, endLine: 10, top: 0, bottom: 100 },
    { line: 1, endLine: 1, top: 0, bottom: 10 },
    { line: 5, endLine: 5, top: 20, bottom: 30 },
  ];
  expect(pickBlockIndex(blocks, 25)).toBe(2);
  expect(interpolateLine(blocks[2]!, 25)).toBe(5);
});

test("cuenta las líneas de un front matter antes del contenido", () => {
  const source = `---\ntitle: Hola\n---\n\n# Título\n\nTexto\n`;
  const tokens = lex(source);
  annotateTokenLines(tokens, source);
  const heading = tokens.filter((token) => token.type === "heading").at(-1);
  expect([heading?.line, heading?.endLine]).toEqual([5, 5]);
  const paragraph = tokens.find((token) => token.type === "paragraph");
  expect([paragraph?.line, paragraph?.endLine]).toEqual([7, 7]);
});

test("splitFrontMatter: quita el bloque y respeta los casos límite", () => {
  expect(splitFrontMatter("---\ntitle: A\n---\n# T\n")).toBe("# T\n");
  expect(splitFrontMatter("---\r\ntitle: A\r\n---\r\n# T\r\n")).toBe("# T\r\n");
  expect(splitFrontMatter("---\ntitle: A\n...\n# T\n")).toBe("# T\n");
  expect(splitFrontMatter("---\ntitle: A\n---\n")).toBe("");
  // Sin cierre, o con algo antes del `---`: es una línea horizontal.
  expect(splitFrontMatter("---\ntitle: A\n")).toBe("---\ntitle: A\n");
  expect(splitFrontMatter("Texto\n\n---\n---\n")).toBe("Texto\n\n---\n---\n");
  expect(splitFrontMatter("---\nA\n---\n---\n")).toBe("---\n");
});

test("anota listas y citas con finales de línea CRLF", () => {
  const source = "# T\r\n\r\n- uno\r\n- dos\r\n\r\n> cita\r\n> dos\r\n";
  const tokens = lex(source);
  annotateTokenLines(tokens, source);
  const list = tokens.find((token) => token.type === "list");
  expect([list?.line, list?.endLine]).toEqual([3, 4]);
  expect(list?.items?.map((item) => [item.line, item.endLine])).toEqual([
    [3, 3],
    [4, 4],
  ]);
  const quote = tokens.find((token) => token.type === "blockquote");
  expect([quote?.line, quote?.endLine]).toEqual([6, 7]);
});
