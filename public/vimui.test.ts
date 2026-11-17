import { expect, test } from "bun:test";
import { vimModeLabel, vimStatusText } from "./vimui.ts";

test("traduce los modos de Vim a la barra de estado", () => {
  expect(vimModeLabel("normal")).toBe("NORMAL");
  expect(vimModeLabel("insert")).toBe("INSERT");
  expect(vimModeLabel("replace")).toBe("REPLACE");
  expect(vimModeLabel("visual")).toBe("VISUAL");
  expect(vimModeLabel("visual line")).toBe("V-LINE");
  expect(vimModeLabel("visual block")).toBe("V-BLOCK");
});

test("muestra el comando pendiente y la macro en curso", () => {
  // `mode` no afecta al texto (se pinta en otro sitio): estos casos cubren
  // pending y recording, que sí son la responsabilidad de vimStatusText.
  expect(vimStatusText({ mode: "normal", pending: "" })).toBe("");
  expect(vimStatusText({ mode: "insert", pending: "d" })).toBe("d");
  expect(vimStatusText({ mode: "visual", pending: "", recording: "q" })).toBe("recording @q");
  expect(vimStatusText({ mode: "normal", pending: '"a', recording: "q" })).toBe('"a recording @q');
});
