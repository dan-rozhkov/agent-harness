import { describe, it, expect } from "vitest";
import { composeToolHandlers, type Surface } from "../surface.js";

const ok = async () => "ok";
const surface = (id: string, names: string[]): Surface => ({
  id,
  title: id,
  tools: Object.fromEntries(names.map((n) => [n, ok])),
});

describe("composeToolHandlers", () => {
  it("merges tools from all surfaces and shared", () => {
    const merged = composeToolHandlers([surface("a", ["x"]), surface("b", ["y"])], { z: ok });
    expect(Object.keys(merged).sort()).toEqual(["x", "y", "z"]);
  });

  it("throws on a duplicate tool name across surfaces", () => {
    expect(() => composeToolHandlers([surface("a", ["x"]), surface("b", ["x"])])).toThrow(
      /Duplicate tool "x".*"a".*"b"/,
    );
  });

  it("throws when a surface collides with a shared tool", () => {
    expect(() => composeToolHandlers([surface("a", ["x"])], { x: ok })).toThrow(/Duplicate tool "x"/);
  });
});
