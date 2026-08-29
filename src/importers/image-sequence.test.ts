import { describe, expect, it } from "vitest";
import { detectImageSequence, sequenceFrameAtTime } from "./image-sequence";

const file = (name: string) => ({ name, size: 10, lastModified: 1, type: "image/png" });

describe("image sequence importer", () => {
  it("detects stable padded patterns, natural order, and missing frames", () => {
    const sequence = detectImageSequence(
      [file("shot_0010.png"), file("notes.txt"), file("shot_0008.png"), file("shot_0011.png")],
      "shot_0010.png",
    );
    expect(sequence.pattern).toBe("shot_[####].png");
    expect(sequence.frames.map((entry) => entry.frame)).toEqual([8, 10, 11]);
    expect(sequence.missingFrames).toEqual([9]);
  });

  it("does not mix different padding, prefixes, or extensions", () => {
    const sequence = detectImageSequence([
      file("a0001.exr"),
      file("a0002.exr"),
      file("a003.exr"),
      file("b0003.exr"),
      file("a0003.png"),
    ]);
    expect(sequence.frames.map((entry) => entry.file.name)).toEqual(["a0001.exr", "a0002.exr"]);
  });

  it("rejects duplicate frame numbers and non-numbered seeds", () => {
    expect(() => detectImageSequence([file("a001.png"), file("a001.PNG")])).toThrow("duplicated");
    expect(() => detectImageSequence([file("still.png")])).toThrow("frame number");
  });

  it("uses rational, time-addressed frame selection", () => {
    const sequence = { startFrame: 1001, endFrame: 1010 };
    const rate = { numerator: 24_000, denominator: 1_001 };
    expect(sequenceFrameAtTime(sequence, 0, rate)).toBe(1001);
    expect(sequenceFrameAtTime(sequence, 1_001 / 24_000, rate)).toBe(1002);
    expect(sequenceFrameAtTime(sequence, 100, rate)).toBe(1010);
    expect(sequenceFrameAtTime(sequence, (10 * 1_001) / 24_000, rate, true)).toBe(1001);
  });
});
