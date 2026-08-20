import { describe, expect, it } from "vitest";
import { breakTextLines } from "./text-rasterizer";

const monospace = (text: string) => Array.from(text).length * 10;
const graphemeMeasure = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length * 10;

describe("Unicode text line breaking", () => {
  it("wraps words while preserving explicit line breaks", () => {
    expect(breakTextLines("GPU first motion\nAster", 90, monospace)).toEqual([
      "GPU first",
      "motion",
      "Aster",
    ]);
  });

  it("breaks long CJK and emoji runs at grapheme boundaries", () => {
    expect(breakTextLines("星辰动画编辑器", 40, monospace)).toEqual(["星辰动画", "编辑器"]);
    expect(breakTextLines("👩🏽‍💻👨‍👩‍👧‍👦", 10, graphemeMeasure)).toEqual(["👩🏽‍💻", "👨‍👩‍👧‍👦"]);
  });

  it("includes tracking in wrap decisions", () => {
    expect(breakTextLines("AB CD", 45, monospace, 5)).toEqual(["AB", "CD"]);
  });
});
