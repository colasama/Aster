import { describe, expect, it } from "vitest";
import { integer, object } from "./canonical";

describe("frame-plan integer validation", () => {
  it("preserves inclusive bounds and rejects unsafe, nonnumeric and negative-zero values", () => {
    for (const value of [-3, 0, 7]) expect(integer(value, -3, 7)).toBe(value);
    expect(integer(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [-4, 8, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null])
      expect(() => integer(value, -3, 7)).toThrow(
        expect.objectContaining({
          name: "FramePlanError",
          code: "invalid_safe_integer",
          message: "Expected an integer in [-3, 7]",
        }),
      );
    expect(() => integer(0, NaN, 1)).toThrow(/Expected an integer/);
    expect(() => integer(0, -1, NaN)).toThrow(/Expected an integer/);
    expect(() => integer(0, 1, -1)).toThrow(/Expected an integer/);
  });
});

describe("closed frame-plan object validation", () => {
  it("accepts own fields in either order without changing the value or expected keys", () => {
    const keys = ["second", "first"];
    for (const value of [
      { first: 1, second: 2 },
      { second: 2, first: 1 },
      Object.assign(Object.create(null), { first: 1, second: 2 }),
    ]) {
      const original = Object.keys(value);
      expect(object(value, keys)).toBe(value);
      expect(Object.keys(value)).toEqual(original);
      expect(keys).toEqual(["second", "first"]);
    }
    expect(object({}, [])).toEqual({});
  });

  it("does not accept inherited fields, missing fields or same-count substitutions", () => {
    const keys = ["second", "first"];
    const inherited = Object.assign(Object.create({ second: 2 }), { first: 1 });
    const hidden = Object.defineProperty({ first: 1 }, "second", { value: 2 });
    for (const value of [
      inherited,
      hidden,
      { first: 1 },
      { first: 1, second: 2, extra: 3 },
      { first: 1, other: 2 },
    ])
      expect(() => object(value, keys)).toThrow(
        expect.objectContaining({
          code: "unknown_field",
          message: "Expected exactly these fields: second, first",
        }),
      );
    expect(() => object({ first: 1, second: 2 }, ["first", "first"])).toThrow(/exactly/);
    for (const value of [null, undefined, [], "object", 1])
      expect(() => object(value, keys)).toThrow(
        expect.objectContaining({ code: "invalid_json", message: "Expected a wire object" }),
      );
  });
});
