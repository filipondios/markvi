import { expect, test } from "bun:test";
import { createViewNav } from "./viewnav.ts";

const press = (nav: ReturnType<typeof createViewNav>, ...keys: string[]) =>
  keys.map((key) => nav.handle({ key }));

test("acumula contadores y los muestra como pendientes", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "5" })).toBeUndefined();
  expect(nav.pending).toBe("5");
  expect(nav.handle({ key: "j" })).toEqual({ type: "moveBlock", count: 5 });
  expect(nav.pending).toBe("");
});

test("j y k mueven bloques, con y sin contador", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "j" })).toEqual({ type: "moveBlock", count: 1 });
  expect(nav.handle({ key: "k" })).toEqual({ type: "moveBlock", count: -1 });
  expect(press(nav, "1", "0", "j")).toEqual([undefined, undefined, { type: "moveBlock", count: 10 }]);
});

test("gg y G van al inicio y al final, y aceptan contador", () => {
  const nav = createViewNav();
  expect(press(nav, "g", "g")).toEqual([undefined, { type: "top", count: undefined }]);
  expect(press(nav, "3", "g", "g")).toEqual([
    undefined,
    undefined,
    { type: "top", count: 3 },
  ]);
  expect(nav.handle({ key: "G" })).toEqual({ type: "bottom", count: undefined });
  expect(press(nav, "4", "G")).toEqual([undefined, { type: "bottom", count: 4 }]);
});

test("gt y gT cambian de pestaña, con contador", () => {
  const nav = createViewNav();
  expect(press(nav, "g", "t")).toEqual([undefined, { type: "tab", direction: 1, count: undefined }]);
  expect(press(nav, "2", "g", "T")).toEqual([
    undefined,
    undefined,
    { type: "tab", direction: -1, count: 2 },
  ]);
});

test("]] y [[ saltan encabezados, con contador", () => {
  const nav = createViewNav();
  expect(press(nav, "]", "]")).toEqual([undefined, { type: "heading", direction: 1, count: 1 }]);
  expect(press(nav, "2", "[", "[")).toEqual([
    undefined,
    undefined,
    { type: "heading", direction: -1, count: 2 },
  ]);
});

test("Ctrl-d, Ctrl-u, Ctrl-o y Ctrl-i", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "d", ctrl: true })).toEqual({ type: "halfPage", direction: 1 });
  expect(nav.handle({ key: "u", ctrl: true })).toEqual({ type: "halfPage", direction: -1 });
  expect(nav.handle({ key: "o", ctrl: true })).toEqual({ type: "history", direction: -1 });
  expect(nav.handle({ key: "i", ctrl: true })).toEqual({ type: "history", direction: 1 });
});

test("búsqueda, coincidencias, pistas y comandos ex", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "/" })).toEqual({ type: "search", direction: 1 });
  expect(nav.handle({ key: "?" })).toEqual({ type: "search", direction: -1 });
  expect(nav.handle({ key: "n" })).toEqual({ type: "nextMatch", direction: 1, count: 1 });
  expect(press(nav, "3", "N")).toEqual([
    undefined,
    { type: "nextMatch", direction: -1, count: 3 },
  ]);
  expect(nav.handle({ key: "f" })).toEqual({ type: "hints" });
  expect(nav.handle({ key: ":" })).toEqual({ type: "ex" });
  expect(nav.handle({ key: "Escape" })).toEqual({ type: "cancel" });
});

test("una secuencia pendiente consume la tecla y descarta el contador", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "g" })).toBeUndefined();
  expect(nav.pending).toBe("g");
  expect(nav.handle({ key: "x" })).toBeUndefined();
  expect(nav.pending).toBe("");

  expect(press(nav, "5", "g", "0")).toEqual([undefined, undefined, undefined]);
  expect(nav.pending).toBe("");
});

test("0 solo cuenta dentro de un número y las teclas desconocidas reinician", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "0" })).toBeUndefined();
  expect(nav.pending).toBe("");
  expect(press(nav, "1", "0", "k")).toEqual([undefined, undefined, { type: "moveBlock", count: -10 }]);

  expect(nav.handle({ key: "5" })).toBeUndefined();
  expect(nav.handle({ key: "z" })).toBeUndefined();
  expect(nav.pending).toBe("");
});

test("ignora Meta y Alt", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "j", meta: true })).toBeUndefined();
  expect(nav.handle({ key: "j", alt: true })).toBeUndefined();
  expect(nav.pending).toBe("");
});

test("AltGr no se confunde con Ctrl ni Alt", () => {
  const nav = createViewNav();
  expect(nav.handle({ key: "]", alt: true, ctrl: true, altGraph: true })).toBeUndefined();
  expect(nav.pending).toBe("]");
  expect(nav.handle({ key: "]", alt: true, ctrl: true, altGraph: true })).toEqual({
    type: "heading",
    direction: 1,
    count: 1,
  });
});
