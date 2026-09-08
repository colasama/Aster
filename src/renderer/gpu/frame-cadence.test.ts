import { describe, expect, it } from "vitest";
import { frameCadenceSample } from "./frame-cadence";

describe("preview frame cadence", () => {
  it("counts slow playback instead of reporting a stalled frame as 60 fps", () => {
    expect(frameCadenceSample(500, true)).toBe(500);
    expect(frameCadenceSample(50, true)).toBe(50);
  });

  it("excludes idle and playback-start gaps and keeps same-tick samples finite", () => {
    expect(frameCadenceSample(5000, false)).toBe(16.67);
    expect(frameCadenceSample(0, true)).toBe(0.1);
  });
});
