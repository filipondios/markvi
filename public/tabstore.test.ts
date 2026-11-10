import { describe, expect, test } from "bun:test";
import { isSafePath, parseStoredTabs, serializeTabs } from "./tabstore.ts";

describe("isSafePath", () => {
  test("acepta rutas Markdown relativas", () => {
    expect(isSafePath("TODO.md")).toBe(true);
    expect(isSafePath("notas/otra nota.md")).toBe(true);
    expect(isSafePath("a/b/c.MD")).toBe(true);
  });

  test("rechaza rutas que no deberían venir del servidor", () => {
    expect(isSafePath("")).toBe(false);
    expect(isSafePath("nota.txt")).toBe(false);
    expect(isSafePath("/TODO.md")).toBe(false);
    expect(isSafePath("../TODO.md")).toBe(false);
    expect(isSafePath("notas/../../TODO.md")).toBe(false);
    expect(isSafePath(".git/config.md")).toBe(false);
    expect(isSafePath("notas//otra.md")).toBe(false);
    expect(isSafePath("notas\\otra.md")).toBe(false);
    expect(isSafePath("a\0.md")).toBe(false);
  });
});

describe("parseStoredTabs", () => {
  test("devuelve una lista vacía si no hay nada o está corrupto", () => {
    expect(parseStoredTabs(null)).toEqual([]);
    expect(parseStoredTabs("")).toEqual([]);
    expect(parseStoredTabs("no es json")).toEqual([]);
    expect(parseStoredTabs("null")).toEqual([]);
    expect(parseStoredTabs("{}")).toEqual([]);
    expect(parseStoredTabs('{"tabs":"no"}')).toEqual([]);
  });

  test("valida, normaliza y elimina duplicados", () => {
    const raw = JSON.stringify({
      tabs: [
        { path: "TODO.md", mode: "edit" },
        { path: "TODO.md", mode: "view" },
        { path: "notas/otra.md" },
        { path: "notas/otra.md", mode: "otro" },
        { path: "../fuera.md", mode: "edit" },
        { path: 42, mode: "view" },
        null,
      ],
    });

    expect(parseStoredTabs(raw)).toEqual([
      { path: "TODO.md", mode: "edit" },
      { path: "notas/otra.md", mode: "view" },
    ]);
  });
});

describe("serializeTabs", () => {
  test("produce un JSON que parseStoredTabs vuelve a leer", () => {
    const tabs = [
      { path: "TODO.md", mode: "view" as const },
      { path: "notas/otra.md", mode: "edit" as const },
    ];
    expect(parseStoredTabs(serializeTabs(tabs))).toEqual(tabs);
  });
});
