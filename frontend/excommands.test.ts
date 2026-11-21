import { expect, test } from "bun:test";
import { parseExCommand, parseForce } from "./excommands.ts";

test("alias canónicos compartidos por editor y vista", () => {
  expect(parseExCommand("e notas")).toEqual({
    name: "edit",
    argument: "notas",
    force: false,
  });
  expect(parseExCommand("mv! viejo nuevo")).toEqual({
    name: "mv",
    argument: "viejo nuevo",
    force: true,
  });
  expect(parseExCommand("delete cosa.md!")?.name).toBe("rm");
  expect(parseExCommand("x")?.name).toBe("wq");
  expect(parseExCommand("noexiste")).toBeUndefined();
});

test("! pegado al comando o al final del argumento", () => {
  expect(parseForce("!")).toEqual({ force: true, argument: "" });
  expect(parseForce("! foo")).toEqual({ force: true, argument: "foo" });
  expect(parseForce("foo!")).toEqual({ force: true, argument: "foo" });
  expect(parseForce("foo bar")).toEqual({ force: false, argument: "foo bar" });
});
