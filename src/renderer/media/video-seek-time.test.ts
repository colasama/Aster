import { describe, expect, it } from "vitest";
import { videoSeekTime } from "./media-texture-cache";

describe("exact video seek time", () => {
  it("biases an exact frame-boundary seek into the intended frame, not the next one", () => {
    for (const fps of [24, 30, 60, 120]) {
      const boundary = 131 / fps;
      expect(videoSeekTime(boundary, 10, false)).toBeGreaterThan(boundary);
      expect(videoSeekTime(boundary, 10, false)).toBeLessThan(132 / fps);
    }
  });

  it("keeps playback seeks unbiased and never passes the last decodable time", () => {
    expect(videoSeekTime(2, 10, true)).toBe(2);
    expect(videoSeekTime(9.99995, 9.99999, false)).toBe(9.99999);
  });
});
