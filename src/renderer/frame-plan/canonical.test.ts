import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  copyWireValue,
  integer,
  object,
  sameCanonicalValue,
  validUnicode,
} from "./canonical";

it("copies nested wire objects independently while retaining exact immutable values", () => {
  const original = {
    text: "large identity \0 空 🦀".repeat(10000),
    nested: [{ values: [1, 2, 3], enabled: true, absent: null }],
    special: JSON.parse('{"__proto__":{"owned":true}}') as Record<string, { owned: boolean }>,
  };
  const copy = copyWireValue(original);
  expect(copy).toEqual(structuredClone(original));
  expect(canonicalJson(copy)).toBe(canonicalJson(original));
  copy.nested[0].values[0] = 99;
  copy.nested[0].enabled = false;
  Object.values(copy.special)[0].owned = false;
  expect(original.nested[0]).toEqual({ values: [1, 2, 3], enabled: true, absent: null });
  expect(Object.values(original.special)[0].owned).toBe(true);
  expect(Object.getPrototypeOf(copy.special)).toBe(Object.prototype);
  expect(Object.getOwnPropertyNames(copy.special)).toEqual(["__proto__"]);
  expect(copyWireValue(Object.assign(Object.create(null), { key: [1] }))).toEqual({ key: [1] });
  for (const value of [undefined, () => 1, new Date(), new Map(), new Uint8Array(4)])
    expect(() => copyWireValue(value)).toThrow(/plain JSON/);
});

it("owns wire keys without invoking inherited setters or inheriting property restrictions", () => {
  const key = "__aster_wire_copy_probe__";
  let setterCalls = 0;
  for (const descriptor of [
    { set: () => setterCalls++ },
    { value: "inherited", writable: false },
  ]) {
    Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true });
    try {
      const input = { [key]: { owned: true } };
      const copy = copyWireValue(input);
      expect(Object.getOwnPropertyDescriptor(copy, key)).toEqual({
        value: { owned: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      copy[key].owned = false;
      expect(input[key].owned).toBe(true);
      expect(setterCalls).toBe(0);
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
  }
});

it("snapshots own enumerable string values before recursively copying nested getters", () => {
  const reads: string[] = [];
  const nested = {
    get value() {
      reads.push("nested");
      return 7;
    },
  };
  const input = {
    get first() {
      reads.push("first");
      return nested;
    },
    get last() {
      reads.push("last");
      return true;
    },
  };
  for (const key of ["hidden", Symbol("hidden")])
    Object.defineProperty(input, key, {
      enumerable: typeof key === "symbol",
      get: () => {
        throw new Error("Non-wire property was read");
      },
    });
  expect(copyWireValue(input)).toEqual({ first: { value: 7 }, last: true });
  expect(reads).toEqual(["first", "last", "nested"]);
});

it("rejects only unpaired UTF-16 code units while preserving canonical string bytes", () => {
  for (let code = 0; code <= 0xffff; code++)
    expect(validUnicode(String.fromCharCode(code))).toBe(code < 0xd800 || code > 0xdfff);
  for (let high = 0xd800; high <= 0xdbff; high++) {
    for (const low of [0xdc00, 0xddff, 0xdfff]) {
      const pair = String.fromCharCode(high, low);
      const text = `prefix\0${pair}\n${pair}suffix`;
      expect(validUnicode(text)).toBe(true);
      expect(canonicalJson(text)).toBe(JSON.stringify(text));
      for (const broken of [pair[0], pair[1], pair[1] + pair[0], `${pair[0]}a${pair[1]}`])
        expect(() => canonicalJson(`prefix${broken}suffix`)).toThrow(/Unpaired UTF-16/);
    }
  }
});

it("compares against verified JSON without accepting changed shape, values or prototypes", () => {
  const verified = { text: "identity", nested: { values: [0, 1, null] } };
  for (const candidate of [
    { nested: { values: [0, 1, null] }, text: "identity" },
    Object.assign(Object.create(null), structuredClone(verified)),
  ]) {
    expect(canonicalJson(candidate)).toBe(canonicalJson(verified));
    expect(sameCanonicalValue(candidate, verified)).toBe(true);
  }
  for (const candidate of [
    { ...verified, text: "changed" },
    { ...verified, extra: undefined },
    { ...verified, nested: { values: [-0, 1, null] } },
    { ...verified, nested: { values: [0, 1] } },
    { ...verified, nested: { values: Array(3) } },
    Object.assign(Object.create({ inherited: true }), verified),
  ])
    expect(sameCanonicalValue(candidate, verified)).toBe(false);
});

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

it("keeps native and fallback Unicode validation identical for long and boundary strings", () => {
  const prototype = String.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "isWellFormed");
  expect(descriptor?.value).toBeTypeOf("function");
  const values = ["", "plain", "空".repeat(10000), "🦀".repeat(10000)];
  for (const code of [0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000]) {
    const unit = String.fromCharCode(code);
    for (const prefix of ["", "abc".repeat(10000), "空".repeat(10000)]) {
      values.push(prefix + unit, unit + prefix, `${prefix}${unit}🦀`);
    }
  }
  const expected = values.map((value) => !/[\uD800-\uDFFF]/u.test(value));
  expect(values.map(validUnicode)).toEqual(expected);
  try {
    Object.defineProperty(prototype, "isWellFormed", { value: undefined, configurable: true });
    expect(values.map(validUnicode)).toEqual(expected);
  } finally {
    if (descriptor) Object.defineProperty(prototype, "isWellFormed", descriptor);
    else Reflect.deleteProperty(prototype, "isWellFormed");
  }
});

it("preserves lexical keys and exact escaping through native and token serialization", () => {
  const special = JSON.parse('{"z":1,"__proto__":{"owned":true},"10":"ten","2":"two","01":"one"}');
  expect(canonicalJson(special)).toBe(
    '{"01":"one","10":"ten","2":"two","__proto__":{"owned":true},"z":1}',
  );
  const plain = Object.assign(Object.create(null), { z: [true, null, -3], a: '\0\n"\\ 空 🦀' });
  expect(canonicalJson(plain)).toBe(`{"a":${JSON.stringify(plain.a)},"z":[true,null,-3]}`);
  expect(Object.getPrototypeOf(plain)).toBe(null);
  expect(canonicalJson(JSON.parse('{"__proto__":{"owned":true}}'))).toBe(
    '{"__proto__":{"owned":true}}',
  );
  const sparse = new Array<number>(3);
  sparse[0] = 1;
  sparse[2] = 3;
  expect(canonicalJson({ sparse })).toBe('{"sparse":[1,,3]}');
  let reads = 0;
  const getter = {
    "2": "two",
    get value() {
      reads++;
      return { z: 3, a: 1 };
    },
  };
  expect(canonicalJson(getter)).toBe('{"2":"two","value":{"a":1,"z":3}}');
  expect(reads).toBe(1);
});

it("rejects unsupported nested values before native JSON can coerce or omit them", () => {
  for (const value of [
    undefined,
    () => 1,
    Symbol("value"),
    1n,
    new Date(),
    new Map(),
    new Uint8Array(4),
  ])
    expect(() => canonicalJson({ value })).toThrow(
      expect.objectContaining({ code: "invalid_json" }),
    );
  for (const value of [-0, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => canonicalJson({ value })).toThrow(
      expect.objectContaining({ code: "invalid_safe_integer" }),
    );
  for (const key of ["", "空", "\n", "\u007f"])
    expect(() => canonicalJson({ [key]: 1 })).toThrow(
      expect.objectContaining({ code: "unknown_field" }),
    );
  expect(() => canonicalJson({ text: "\ud800" })).toThrow(
    expect.objectContaining({ code: "invalid_utf8" }),
  );
  expect(() => canonicalJson({ toJSON: () => "coerced" })).toThrow(
    expect.objectContaining({ code: "invalid_json" }),
  );
});
