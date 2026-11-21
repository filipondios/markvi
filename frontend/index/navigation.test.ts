import { expect, test } from "bun:test";
import { createListNav } from "./navigation.ts";

const nav = createListNav();
const key = (key: string, extra: Record<string, boolean> = {}) =>
  nav.handle({ key, ...extra });

test("j/k mueven con conteo y sin él", () => {
  expect(key("3")).toBeUndefined();
  expect(key("j")).toEqual({ type: "move", count: 3 });
  expect(key("k")).toEqual({ type: "move", count: -1 });
  expect(key("0")).toBeUndefined(); // un `0` suelto no es comando
  expect(key("1")).toBeUndefined();
  expect(key("0")).toBeUndefined();
  expect(key("k")).toEqual({ type: "move", count: -10 });
});

test("gg y G van a los extremos y el prefijo g no entra en conflicto", () => {
  expect(key("g")).toBeUndefined();
  expect(nav.pending).toBe("g");
  expect(key("g")).toEqual({ type: "top" });

  // `g` + otra tecla se consume y cancela el prefijo; nada se dispara.
  expect(key("g")).toBeUndefined();
  expect(key("x")).toBeUndefined();
  expect(nav.pending).toBe("");

  expect(key("G")).toEqual({ type: "bottom" });
});

test("/ filtra, Enter abre y Esc cancela", () => {
  expect(key("/")).toEqual({ type: "filter" });
  expect(key("Enter")).toEqual({ type: "open" });
  expect(key("Escape")).toEqual({ type: "cancel" });
});

test("las teclas con modificadores pasan sin consumir y limpian el pendiente", () => {
  expect(key("2")).toBeUndefined();
  expect(key("d", { ctrl: true })).toBeUndefined();
  expect(nav.pending).toBe("");
  expect(key("j", { meta: true })).toBeUndefined();
  expect(key("j", { alt: true })).toBeUndefined();
  // AltGr cuenta como tal: `j` con AltGraph sigue siendo movimiento.
  expect(key("j", { alt: true, altGraph: true })).toEqual({ type: "move", count: 1 });
});

test("reset limpia cualquier estado pendiente", () => {
  key("5");
  key("g");
  expect(nav.pending).toBe("5g");
  nav.reset();
  expect(nav.pending).toBe("");
  expect(key("j")).toEqual({ type: "move", count: 1 });
});
