// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { parseSvgSource } from "./svg";
import { computeSvgRasterTarget, SvgRasterCache, svgMarkupAtRasterSize } from "./svg-raster-cache";

const source = () =>
  parseSvgSource(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
  );

describe("SVG vector raster cache", () => {
  it("targets physical pixels and downscales uniformly to GPU limits", () => {
    expect(
      computeSvgRasterTarget({
        displayWidth: 800,
        displayHeight: 400,
        resolutionScale: 0.5,
        devicePixelRatio: 2,
      }),
    ).toEqual({
      width: 800,
      height: 400,
      requestedWidth: 800,
      requestedHeight: 400,
      downsampleScale: 1,
    });
    const bounded = computeSvgRasterTarget({
      displayWidth: 20_000,
      displayHeight: 10_000,
      resolutionScale: 1,
      maxTextureDimension: 4096,
      maxPixels: 8_000_000,
    });
    expect(bounded.width / bounded.height).toBeCloseTo(2, 3);
    expect(bounded.width).toBeLessThanOrEqual(4096);
    expect(bounded.width * bounded.height).toBeLessThanOrEqual(8_000_000);
    expect(bounded.downsampleScale).toBeLessThan(1);
  });

  it("changes only raster size while preserving vector coordinates", () => {
    const markup = svgMarkupAtRasterSize(source().sanitized, 1600, 800);
    const root = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    expect(root.getAttribute("width")).toBe("1600");
    expect(root.getAttribute("height")).toBe("800");
    expect(root.getAttribute("viewBox")).toBe("0 0 100 50");
    expect(root.querySelector("rect")).not.toBeNull();
  });

  it("deduplicates exact targets and separates source revisions and sizes", async () => {
    const rasterize = vi.fn(async (_markup: string, width: number, height: number) => ({
      id: `${width}x${height}`,
    }));
    const cache = new SvgRasterCache({ rasterize, maxEntries: 4 });
    const parsed = source();
    const target = computeSvgRasterTarget({
      displayWidth: 200,
      displayHeight: 100,
      resolutionScale: 1,
    });
    const [first, second] = await Promise.all([
      cache.get("revision-a", parsed, target),
      cache.get("revision-a", parsed, target),
    ]);
    expect(first).toBe(second);
    expect(rasterize).toHaveBeenCalledTimes(1);
    await cache.get("revision-b", parsed, target);
    await cache.get("revision-a", parsed, { ...target, width: 400, height: 200 });
    expect(rasterize).toHaveBeenCalledTimes(3);
  });

  it("evicts least-recently-used raster resources by byte budget", async () => {
    const disposed: string[] = [];
    const cache = new SvgRasterCache({
      rasterize: async (_markup, width, height) => `${width}x${height}`,
      dispose: (raster) => disposed.push(raster),
      maxEntries: 4,
      maxBytes: 80_000,
    });
    const parsed = source();
    const target = (width: number, height: number) => ({
      width,
      height,
      requestedWidth: width,
      requestedHeight: height,
      downsampleScale: 1,
    });
    await cache.get("svg", parsed, target(100, 100));
    await cache.get("svg", parsed, target(50, 50));
    await cache.get("svg", parsed, target(100, 100));
    await cache.get("svg", parsed, target(100, 100));
    await cache.get("svg", parsed, target(90, 90));
    expect(disposed).toEqual(["50x50"]);
    expect(cache.bytes).toBe(72_400);
    cache.clear();
    expect(new Set(disposed)).toEqual(new Set(["50x50", "100x100", "90x90"]));
  });
});
