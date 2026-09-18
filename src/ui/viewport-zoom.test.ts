import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT_ZOOM,
  fitViewportZoom,
  MAX_VIEWPORT_ZOOM,
  MIN_VIEWPORT_ZOOM,
  normalizeViewportZoom,
  VIEWPORT_ZOOM_PRESETS,
  viewportWheelZoom,
  viewportZoomPercent,
} from "./viewport-zoom";

describe("viewport zoom", () => {
  it("supports standard magnifications through 800 percent", () => {
    expect(VIEWPORT_ZOOM_PRESETS).toEqual([0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8]);
    expect(MIN_VIEWPORT_ZOOM).toBe(0.01);
    expect(MAX_VIEWPORT_ZOOM).toBe(8);
  });

  it("normalizes every input path with one finite bounded policy", () => {
    expect(normalizeViewportZoom(0)).toBe(MIN_VIEWPORT_ZOOM);
    expect(normalizeViewportZoom(800)).toBe(MAX_VIEWPORT_ZOOM);
    expect(normalizeViewportZoom(Number.NaN)).toBe(DEFAULT_VIEWPORT_ZOOM);
    expect(viewportZoomPercent(8)).toBe(800);
  });
  it("uses smooth wheel magnification with Shift acceleration and Ctrl/Cmd precision", () => {
    const event = { deltaY: -100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false };
    expect(viewportWheelZoom(1, event, 600)).toBeCloseTo(1.12);
    expect(viewportWheelZoom(1, { ...event, shiftKey: true }, 600)).toBeCloseTo(1.12 ** 4);
    expect(viewportWheelZoom(1, { ...event, ctrlKey: true }, 600)).toBeCloseTo(1.12 ** 0.25);
    expect(viewportWheelZoom(1, { ...event, metaKey: true }, 600)).toBeCloseTo(1.12 ** 0.25);
    expect(viewportWheelZoom(1, { ...event, shiftKey: true, ctrlKey: true }, 600)).toBeCloseTo(
      1.12,
    );
    expect(viewportWheelZoom(1.12, { ...event, deltaY: 100 }, 600)).toBeCloseTo(1);
    expect(viewportWheelZoom(8, event, 600)).toBe(8);
    expect(viewportWheelZoom(0.01, { ...event, deltaY: 100 }, 600)).toBe(0.01);
    for (const deltaY of [0, Number.NaN, Infinity])
      expect(viewportWheelZoom(1, { ...event, deltaY }, 600)).toBe(1);
    expect(viewportWheelZoom(1, { ...event, deltaMode: 1, deltaY: -6.25 }, 600)).toBeCloseTo(1.12);
    expect(viewportWheelZoom(1, { ...event, deltaMode: 2, deltaY: -1 }, 100)).toBeCloseTo(1.12);
  });
  it("fits 4K and portrait compositions, split viewers and the 100% cap", () => {
    expect(fitViewportZoom(800, 600, 3840, 2160)).toBeCloseTo(736 / 3840);
    expect(fitViewportZoom(800, 600, 1080, 1920)).toBeCloseTo(536 / 1920);
    expect(fitViewportZoom(800, 600, 3840, 2160, 2)).toBeCloseTo(704 / 7680);
    expect(fitViewportZoom(1000, 800, 100, 100, 1, 1)).toBe(1);
    expect(fitViewportZoom(1000, 800, 100, 100)).toBe(7.36);
    expect(fitViewportZoom(0, 0, 3840, 2160)).toBe(MIN_VIEWPORT_ZOOM);
  });
});
