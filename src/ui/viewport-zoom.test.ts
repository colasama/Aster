import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT_ZOOM,
  MAX_VIEWPORT_ZOOM,
  MIN_VIEWPORT_ZOOM,
  normalizeViewportZoom,
  VIEWPORT_ZOOM_PRESETS,
  viewportZoomPercent,
} from "./viewport-zoom";

describe("viewport zoom", () => {
  it("supports standard magnifications through 800 percent", () => {
    expect(VIEWPORT_ZOOM_PRESETS).toEqual([0.25, 0.5, 1, 2, 4, 8]);
    expect(MIN_VIEWPORT_ZOOM).toBe(0.25);
    expect(MAX_VIEWPORT_ZOOM).toBe(8);
  });

  it("normalizes every input path with one finite bounded policy", () => {
    expect(normalizeViewportZoom(0)).toBe(MIN_VIEWPORT_ZOOM);
    expect(normalizeViewportZoom(800)).toBe(MAX_VIEWPORT_ZOOM);
    expect(normalizeViewportZoom(Number.NaN)).toBe(DEFAULT_VIEWPORT_ZOOM);
    expect(viewportZoomPercent(8)).toBe(800);
  });
});
