import { expect, test } from "bun:test";
import { readingBlockIndex, readingReferenceY, type BlockBox } from "./lines.ts";
import { createReadingCursor } from "./readingcursor.ts";

const blocks: BlockBox[] = [
  { line: 1, endLine: 1, top: 100, bottom: 140 },
  { line: 3, endLine: 3, top: 220, bottom: 260 },
  { line: 5, endLine: 8, top: 340, bottom: 500 },
];

test("elige el primer y último bloque en los límites de scroll", () => {
  expect(readingBlockIndex(blocks, 130, 0, 900)).toBe(0);
  expect(readingBlockIndex(blocks, 800, 900, 900)).toBe(2);
});

test("fuerza el primer/último bloque en los topes aunque la referencia caiga más abajo/arriba", () => {
  expect(readingBlockIndex(blocks, 450, 0, 900)).toBe(0);
  expect(readingBlockIndex(blocks, 120, 900, 900)).toBe(2);
  expect(readingBlockIndex(blocks, 450, 450, 900)).toBe(2);
});

test("la referencia de lectura baja progresivamente en el tramo final del scroll", () => {
  const reference = 300;
  const viewportBottom = 900;
  const maxScroll = 3000;
  const transition = viewportBottom - reference;
  const samples = [
    maxScroll - transition,
    maxScroll - transition * 0.75,
    maxScroll - transition * 0.5,
    maxScroll - transition * 0.25,
    maxScroll,
  ].map((scrollTop) => readingReferenceY(reference, viewportBottom, scrollTop, maxScroll));

  expect(samples).toEqual([300, 450, 600, 750, 900]);
  expect(samples.every((value, index) => index === 0 || value > samples[index - 1]!)).toBe(true);
});

test("para documentos sin scroll usa la línea de referencia geométrica", () => {
  expect(readingBlockIndex(blocks, 250, 0, 0)).toBe(1);
});

test("mantiene cursor explícito aunque el scroll esté topado", () => {
  const cursor = createReadingCursor();
  cursor.sync(blocks, 50, 0, 900);
  expect(cursor.index).toBe(0);
  expect(cursor.move(1, blocks, 50, 0, 900)).toBe(1);
  expect(cursor.move(1, blocks, 50, 0, 900)).toBe(2);
  expect(cursor.move(1, blocks, 50, 0, 900)).toBe(2);
  expect(cursor.move(-2, blocks, 900, 900, 900)).toBe(0);
});

test("mueve el cursor en un documento corto aunque no exista scroll", () => {
  const shortBlocks: BlockBox[] = [
    { line: 1, endLine: 1, top: 80, bottom: 110 },
    { line: 3, endLine: 3, top: 150, bottom: 180 },
    { line: 5, endLine: 5, top: 220, bottom: 250 },
  ];
  const cursor = createReadingCursor();
  expect(cursor.current(shortBlocks, 170, 0, 0)).toBe(1);
  expect(cursor.move(1, shortBlocks, 170, 0, 0)).toBe(2);
  expect(cursor.move(-1, shortBlocks, 170, 0, 0)).toBe(1);
});

test("re-sincroniza rueda/barra y maneja mapas vacíos", () => {
  const cursor = createReadingCursor();
  expect(cursor.sync(blocks, 240, 200, 900)).toBe(1);
  expect(cursor.sync([], 240, 200, 900)).toBe(-1);
  expect(cursor.index).toBeUndefined();
  expect(cursor.move(1, [], 0, 0, 0)).toBe(-1);
});
