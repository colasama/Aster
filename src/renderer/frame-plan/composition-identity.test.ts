import { describe, expect, it } from "vitest";
import { compositionIdentityFromString, compositionIdentityToString } from "./composition-identity";

describe("exact composition identity", () => {
  it("preserves existing nonempty project strings including long, NUL and supplementary identities", () => {
    for (const id of ["root", "a".repeat(257), "中".repeat(100), "\0", "root\0tail", "🎞️"]) {
      const encoded = compositionIdentityFromString(id);
      expect(encoded).toBe(id);
      expect(compositionIdentityToString(JSON.parse(JSON.stringify(encoded)))).toBe(id);
    }
  });

  it("round-trips unpaired UTF-16 units without replacement or Unicode normalization", () => {
    for (const id of [
      "\ud800",
      "\udc00",
      "a\ud800b\udc00",
      "A🎞\ud800B\udfff",
      `${"a".repeat(131072)}\ud800x\udc00`,
    ]) {
      const encoded = compositionIdentityFromString(id);
      expect(typeof encoded).toBe("object");
      expect(compositionIdentityToString(JSON.parse(JSON.stringify(encoded)))).toBe(id);
      expect(compositionIdentityFromString(compositionIdentityToString(encoded))).toEqual(encoded);
    }
    expect(compositionIdentityFromString("A🎞\ud800B\udfff")).toEqual({
      utf16_units: [0x41, 0xd83c, 0xdf9e, 0xd800, 0x42, 0xdfff],
    });
  });

  it("rejects noncanonical alternate encodings and invalid code units", () => {
    expect(() => compositionIdentityFromString("")).toThrow();
    for (const encoded of [
      "",
      "\ud800",
      {},
      { utf16_units: [] },
      { utf16_units: [0] },
      { utf16_units: [65] },
      { utf16_units: [0xd83d, 0xdcfd] },
      { utf16_units: [0xd800], extra: true },
      { utf16_units: [0xd800, -1] },
      { utf16_units: [0xd800, 65536] },
      { utf16_units: [0xd800, 0.5] },
      { utf16_units: [0xd800, -0] },
      { utf16_units: [0xd800, NaN] },
      { utf16_units: [0xd800, "65"] },
      { utf16_units: [0xd800, ...Array(1)] },
    ])
      expect(() => compositionIdentityToString(encoded)).toThrow();
  });
});
