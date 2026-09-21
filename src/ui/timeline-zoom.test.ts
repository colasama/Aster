import { expect, it } from "vitest";
import { timelineTicks, timelineZoomBounds } from "./timeline-zoom";

it("fits long compositions below the old minimum and renders only visible frame-aligned ticks", () => {
  const duration = 3600;
  const frame = 1001 / 30000;
  const bounds = timelineZoomBounds(duration, frame, 900);
  expect(bounds.min).toBeLessThan(0.5);
  expect(bounds.max * 82 * frame).toBeCloseTo(24);
  for (const zoom of [bounds.min, 1, bounds.max]) {
    const pps = zoom * 82;
    const scroll = 1800 * pps;
    const ruler = timelineTicks(duration, frame, pps, scroll, 1186);
    expect(ruler.ticks.length).toBeLessThan(100);
    for (const tick of ruler.ticks) {
      expect(tick.time / frame).toBeCloseTo(Math.round(tick.time / frame));
      expect(tick.time * pps).toBeGreaterThanOrEqual(scroll - 286 - ruler.interval * pps);
      expect(tick.time * pps).toBeLessThanOrEqual(scroll + 900 + ruler.interval * pps);
    }
  }
  expect(timelineTicks(duration, frame, bounds.max * 82, 0, 1186).showFrames).toBe(true);
});
