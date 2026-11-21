import { expect, test } from "bun:test";
import { extractHeadings, plainText } from "./toc.ts";

test("extrae encabezados ATX y setext con sus líneas", () => {
  const source = `# Uno

Texto

## Dos

Más

Tres
====

### Tres punto uno

Final
`;
  const headings = extractHeadings(source);
  expect(headings.map((heading) => [heading.level, heading.text, heading.line])).toEqual([
    [1, "Uno", 1],
    [2, "Dos", 5],
    [1, "Tres", 9],
    [3, "Tres punto uno", 12],
  ]);
});

test("ignora los encabezados dentro de bloques de código", () => {
  const source = `# Real

\`\`\`md
# Falso
\`\`\`

## Otra
`;
  const headings = extractHeadings(source);
  expect(headings.map((heading) => heading.text)).toEqual(["Real", "Otra"]);
});

test("calcula el final de cada sección por nivel", () => {
  const source = `# A

## B

### C

## D

# E
`;
  const headings = extractHeadings(source);
  expect(headings.map((heading) => [heading.text, heading.sectionEnd])).toEqual([
    ["A", 9],
    ["B", 7],
    ["C", 7],
    ["D", 9],
    ["E", 11],
  ]);
});

test("limpia el marcado inline del título", () => {
  expect(plainText("**Hola** y [mundo](https://x) `code`")).toBe("Hola y mundo code");
  expect(plainText("![alt](img.png) título")).toBe("alt título");
});

test("funciona con finales de línea CRLF", () => {
  const source = "# Uno\r\n\r\n## Dos\r\n";
  const headings = extractHeadings(source);
  expect(headings.map((heading) => [heading.text, heading.line])).toEqual([
    ["Uno", 1],
    ["Dos", 3],
  ]);
});
