import { describe, expect, test } from "bun:test";
import { createLeader, isModifierKey } from "./keys.ts";

describe("createLeader", () => {
  test("ignora teclas si no se ha pulsado la líder", () => {
    const leader = createLeader([{ keys: ["f"], run: () => {} }], { timeout: 0 });
    expect(leader.active).toBe(false);
    expect(leader.feed("f")).toBe("ignored");
  });

  test("ejecuta una acción de una sola tecla", () => {
    let calls = 0;
    const leader = createLeader([{ keys: ["f"], run: () => calls++ }], { timeout: 0 });

    leader.start();
    expect(leader.active).toBe(true);
    expect(leader.feed("f")).toBe("handled");
    expect(calls).toBe(1);
    expect(leader.active).toBe(false);
  });

  test("soporta secuencias de varias teclas", () => {
    const calls: string[] = [];
    const leader = createLeader(
      [
        { keys: ["g", "t"], run: () => calls.push("gt") },
        { keys: ["g", "d"], run: () => calls.push("gd") },
        { keys: ["f"], run: () => calls.push("f") },
      ],
      { timeout: 0 },
    );

    leader.start();
    expect(leader.feed("g")).toBe("pending");
    expect(leader.active).toBe(true);
    expect(leader.feed("t")).toBe("handled");
    expect(calls).toEqual(["gt"]);
  });

  test("una secuencia desconocida cancela la líder", () => {
    let calls = 0;
    const leader = createLeader([{ keys: ["f"], run: () => calls++ }], { timeout: 0 });

    leader.start();
    expect(leader.feed("x")).toBe("miss");
    expect(leader.active).toBe(false);
    expect(leader.feed("f")).toBe("ignored");
    expect(calls).toBe(0);
  });

  test("cancel() olvida la secuencia pendiente", () => {
    const leader = createLeader([{ keys: ["f"], run: () => {} }], { timeout: 0 });

    leader.start();
    leader.cancel();
    expect(leader.active).toBe(false);
    expect(leader.feed("f")).toBe("ignored");
  });

  test("la secuencia caduca tras el timeout", async () => {
    const leader = createLeader([{ keys: ["f"], run: () => {} }], { timeout: 5 });

    leader.start();
    expect(leader.active).toBe(true);
    await Bun.sleep(20);
    expect(leader.active).toBe(false);
  });

  test("timeout 0 mantiene activa la líder hasta cancelar o resolver", async () => {
    const leader = createLeader([{ keys: ["f"], run: () => {} }], { timeout: 0 });
    leader.start();
    await Bun.sleep(30);
    expect(leader.active).toBe(true);
    expect(leader.feed("f")).toBe("handled");
    expect(leader.active).toBe(false);
  });

  test("identifica modificadores para ignorarlos durante la líder", () => {
    for (const key of ["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]) {
      expect(isModifierKey(key)).toBe(true);
    }
    for (const key of [" ", "Escape", "f", "ArrowDown"]) {
      expect(isModifierKey(key)).toBe(false);
    }

    const leader = createLeader([{ keys: ["f"], run: () => {} }], { timeout: 0 });
    leader.start();
    for (const key of ["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]) {
      if (isModifierKey(key)) expect(leader.active).toBe(true);
    }
    expect(leader.feed("f")).toBe("handled");
  });

  test("expone la secuencia pendiente y las continuaciones", () => {
    const leader = createLeader(
      [
        { keys: ["g", "t"], label: "Pestaña siguiente", run: () => {} },
        { keys: ["g", "d"], label: "Definición", run: () => {} },
        { keys: ["f"], label: "Buscar", run: () => {} },
      ],
      { timeout: 0 },
    );

    leader.start();
    expect(leader.pending).toEqual([]);
    expect(leader.available().map((action) => action.label)).toEqual([
      "Pestaña siguiente",
      "Definición",
      "Buscar",
    ]);

    leader.feed("g");
    expect(leader.pending).toEqual(["g"]);
    expect(leader.available().map((action) => action.label)).toEqual([
      "Pestaña siguiente",
      "Definición",
    ]);
  });

  test("onCancel se llama al cancelar, fallar o ejecutar", () => {
    let cancels = 0;
    const leader = createLeader([{ keys: ["f"], run: () => {} }], {
      timeout: 0,
      onCancel: () => cancels++,
    });

    leader.start();
    leader.cancel();
    expect(cancels).toBe(1);

    leader.start();
    leader.feed("x");
    expect(cancels).toBe(2);

    leader.start();
    leader.feed("f");
    expect(cancels).toBe(3);
  });
});
