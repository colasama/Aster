// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { parseSvgSource } from "./svg";
import {
  computeSvgRasterTarget,
  rasterizeSvgToImageBitmap,
  SvgRasterCache,
  svgMarkupAtRasterSize,
  svgTransformedRasterSize,
} from "./svg-raster-cache";

const source = () =>
  parseSvgSource(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
  );

describe("SVG vector raster cache", () => {
  it("keeps the SVG viewport aspect during nonuniform animation and mirror transforms", () => {
    const stretched = svgTransformedRasterSize([400, 200], [100, 300]);
    expect(stretched).toEqual({ displayWidth: 1200, displayHeight: 600 });
    // Changing the non-dominant axis reuses the raster; only GPU geometry must change.
    expect(svgTransformedRasterSize([400, 200], [-220, 300])).toEqual(stretched);
    const raster = computeSvgRasterTarget({ ...stretched, resolutionScale: 1 });
    const root = new DOMParser().parseFromString(
      svgMarkupAtRasterSize(source().sanitized, raster.width, raster.height),
      "image/svg+xml",
    ).documentElement;
    expect(Number(root.getAttribute("width")) / Number(root.getAttribute("height"))).toBe(2);
    expect(root.getAttribute("viewBox")).toBe("0 0 100 50");
  });
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

  it("does not resurrect an in-flight raster after the source cache is cleared", async () => {
    let release: ((value: string) => void) | undefined;
    const cache = new SvgRasterCache({
      rasterize: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const parsed = source();
    const target = computeSvgRasterTarget({
      displayWidth: 100,
      displayHeight: 50,
      resolutionScale: 1,
    });
    const pending = cache.get("svg", parsed, target);
    cache.clear();
    release?.("stale");
    await expect(pending).resolves.toBe("stale");
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("falls back to DOM rasterization when hidden-renderer bitmap decode rejects SVG", async () => {
    const expected = { width: 320, height: 180, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The source image could not be decoded", "InvalidStateError"),
      )
      .mockResolvedValueOnce(expected);
    vi.stubGlobal("createImageBitmap", createBitmap);
    const decode = vi.fn(async () => undefined);
    vi.stubGlobal(
      "Image",
      class {
        decoding = "auto";
        src = "";
        decode = decode;
      },
    );
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage,
      })),
    } as unknown as HTMLCanvasElement;
    const createElement = vi.spyOn(document, "createElement").mockReturnValue(canvas);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:svg");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await expect(rasterizeSvgToImageBitmap(source().sanitized, 320, 180)).resolves.toBe(expected);
    expect(decode).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 320, 180);
    expect(createBitmap).toHaveBeenCalledTimes(2);
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:svg");
    createElement.mockRestore();
  });
});
