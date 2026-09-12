import { describe, expect, it } from "vitest";
import { formatTimecode, parsePreviewTimecode } from "./preview-timecode";
import { parseViewerGuides, rulerTicks } from "./viewer-guides";

describe("preview navigation", () => {
  it("parses frame counts, seconds, and round-trips fractional-rate non-drop timecodes", () => {
    const rate = { numerator: 30000, denominator: 1001 };
    const time = 1831 / (rate.numerator / rate.denominator);
    expect(parsePreviewTimecode(formatTimecode(time, rate), rate)).toBeCloseTo(time);
    expect(parsePreviewTimecode("120f", { numerator: 60, denominator: 1 })).toBe(2);
    expect(parsePreviewTimecode("1.5s", { numerator: 24, denominator: 1 })).toBe(1.5);
    for (const text of ["", "-1", "NaN", "00:60:00:00", "00:00:00:24", "1;2;3;4"])
      expect(parsePreviewTimecode(text, { numerator: 24, denominator: 1 })).toBeUndefined();
  });
  it("loads only bounded, finite, unique reference guides", () => {
    expect(parseViewerGuides("broken")).toEqual([]);
    expect(
      parseViewerGuides(
        JSON.stringify([
          { id: "x", axis: "x", position: 120 },
          { id: "x", axis: "y", position: 900 },
          { id: "y", axis: "bad", position: 50 },
          { id: "z", axis: "y", position: -1 },
          { id: "n", axis: "y", position: null },
        ]),
      ),
    ).toEqual([{ id: "x", axis: "x", position: 120 }]);
    expect(
      parseViewerGuides(
        JSON.stringify(
          Array.from({ length: 200 }, (_, i) => ({ id: String(i), axis: "x", position: i })),
        ),
      ),
    ).toHaveLength(128);
  });
  it("keeps ruler labels readable and tick allocation bounded", () => {
    const ticks = rulerTicks(3840, 0.2);
    expect(ticks[0]).toBe(0);
    expect((ticks[1] - ticks[0]) * 0.2).toBeGreaterThanOrEqual(70);
    expect(rulerTicks(100_000, 8).length).toBeLessThanOrEqual(512);
    expect(rulerTicks(100, 0)).toEqual([]);
  });
});
