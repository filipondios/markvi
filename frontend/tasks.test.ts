import { expect, test } from "bun:test";
import { taskState, toggleTask } from "./tasks.ts";

const doc = [
  "# Tareas", //                  1
  "", //                          2
  "- [ ] primera", //             3
  "- [x] segunda", //             4
  "  - [ ] anidada", //           5
  "* [X] mayúscula", //           6
  "1. [ ] numerada", //           7
  "2) [x] con paréntesis", //     8
  "> - [ ] en una cita", //       9
  "> > * [x] cita anidada", //   10
  "- texto normal", //           11
  "- [] sin espacio", //         12
  "- [ ]pegado", //              13
  "\t- [ ] con tabulador", //    14
].join("\n");

test("taskState distingue marcada, sin marcar y no tarea", () => {
  expect(taskState(doc, 3)).toBe(false);
  expect(taskState(doc, 4)).toBe(true);
  expect(taskState(doc, 6)).toBe(true);
  expect(taskState(doc, 1)).toBeNull();
  expect(taskState(doc, 11)).toBeNull();
  expect(taskState(doc, 12)).toBeNull();
  expect(taskState(doc, 13)).toBeNull();
});

test("toggleTask invierte la casilla y deja el resto intacto", () => {
  const result = toggleTask(doc, 3);
  expect(result?.checked).toBe(true);
  const lines = result!.text.split("\n");
  expect(lines[2]).toBe("- [x] primera");
  expect(lines.filter((_, index) => index !== 2)).toEqual(
    doc.split("\n").filter((_, index) => index !== 2),
  );

  expect(toggleTask(doc, 4)?.text.split("\n")[3]).toBe("- [ ] segunda");
  expect(toggleTask(doc, 6)?.text.split("\n")[5]).toBe("* [ ] mayúscula");
});

test("toggleTask admite sangría, listas numeradas, citas y tabuladores", () => {
  expect(toggleTask(doc, 5)?.text.split("\n")[4]).toBe("  - [x] anidada");
  expect(toggleTask(doc, 7)?.text.split("\n")[6]).toBe("1. [x] numerada");
  expect(toggleTask(doc, 8)?.text.split("\n")[7]).toBe("2) [ ] con paréntesis");
  expect(toggleTask(doc, 9)?.text.split("\n")[8]).toBe("> - [x] en una cita");
  expect(toggleTask(doc, 10)?.text.split("\n")[9]).toBe("> > * [ ] cita anidada");
  expect(toggleTask(doc, 14)?.text.split("\n")[13]).toBe("\t- [x] con tabulador");
});

test("con `checked` explícito no invierte: fija el estado", () => {
  expect(toggleTask(doc, 3, true)?.text.split("\n")[2]).toBe("- [x] primera");
  expect(toggleTask(doc, 4, true)?.text).toBe(doc);
  expect(toggleTask(doc, 4, true)?.checked).toBe(true);
  expect(toggleTask(doc, 4, false)?.text.split("\n")[3]).toBe("- [ ] segunda");
});

test("devuelve null si la línea no es una tarea o no existe", () => {
  expect(toggleTask(doc, 1)).toBeNull();
  expect(toggleTask(doc, 11)).toBeNull();
  expect(toggleTask(doc, 12)).toBeNull();
  expect(toggleTask(doc, 0)).toBeNull();
  expect(toggleTask(doc, 999)).toBeNull();
  expect(toggleTask(doc, 1.5)).toBeNull();
});

test("conserva los finales de línea CRLF", () => {
  const crlf = "- [ ] uno\r\n- [x] dos\r\n";
  expect(toggleTask(crlf, 1)?.text).toBe("- [x] uno\r\n- [x] dos\r\n");
  expect(toggleTask(crlf, 2)?.text).toBe("- [ ] uno\r\n- [ ] dos\r\n");
  expect(taskState(crlf, 2)).toBe(true);
});

test("funciona en la última línea sin salto final y con texto Unicode delante", () => {
  const source = "ñandú ✓\n- [ ] último";
  expect(toggleTask(source, 2)?.text).toBe("ñandú ✓\n- [x] último");
});
