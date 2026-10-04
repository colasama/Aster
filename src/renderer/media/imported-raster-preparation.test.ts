import { afterEach, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import type { FootageSource } from "../../core/types";
import type { RuntimePsdLayer } from "../../importers/media-import-runtime";
import { readRasterBounds } from "../frame-plan/raster-sample";
import { uploadImageRaster } from "./image-raster-upload";
import { preparePsdRaster, prepareSvgRaster } from "./imported-raster-preparation";

afterEach(() => vi.unstubAllGlobals());

const footage: FootageSource = {
  id: "asset",
  kind: "still",
  name: "Imported raster",
  mimeType: "image/png",
  contentIdentity: "asset-version-1",
  width: 4,
  height: 3,
  runtimeUrl: "https://assets.invalid/raster.png",
  interpretation: { alpha: "straight", colorSpace: "srgb" },
};

it("uploads a captured PSD crop without consulting the changed runtime document", () => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 8 });
  const runtime: RuntimePsdLayer = {
    kind: "psd",
    documentIdentity: "document-1",
    layerKey: "layer-1",
    importMode: "composition",
    decodedWidth: 4,
    decodedHeight: 3,
    crop: [1, 1, 2, 2],
    pixels: new Uint8ClampedArray(48),
  };
  const prepared = preparePsdRaster(runtime, footage, "authorized-locator", 8192, 1024);
  const capturedBytes = runtime.pixels;
  runtime.crop = [0, 0, 1, 1];
  runtime.documentIdentity = "document-2";
  runtime.pixels = new Uint8ClampedArray(48);
  const writeTexture = vi.fn();
  const texture = { destroy: vi.fn() } as unknown as GPUTexture;
  const destination = {
    device: {
      createTexture: vi.fn(() => texture),
      queue: { writeTexture },
    } as unknown as GPUDevice,
    label: "Prepared PSD",
    maximumDimension: 8192,
    maximumBytes: 1024,
    createBindGroup: () => ({}) as GPUBindGroup,
  };
  const uploaded = uploadImageRaster(prepared.pixels, destination);
  expect(writeTexture).toHaveBeenCalledWith(
    { texture },
    capturedBytes,
    { offset: 20, bytesPerRow: 16, rowsPerImage: 3 },
    [2, 2],
  );
  expect(uploaded.textureWidth).toBe(2);
  expect(readRasterBounds(prepared.identity.sample)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  const changed = preparePsdRaster(runtime, footage, "authorized-locator", 8192, 1024);
  expect(changed.identity).not.toEqual(prepared.identity);
  expect(changed.source).not.toBe(prepared.source);
  const failing = {
    ...destination,
    createBindGroup: () => {
      throw new Error("binding failed");
    },
  };
  expect(() => uploadImageRaster(prepared.pixels, failing)).toThrow("binding failed");
  expect(texture.destroy).toHaveBeenCalledOnce();
  if (prepared.pixels.kind !== "rgba") throw Error("Expected RGBA raster");
  expect(() =>
    uploadImageRaster({ ...prepared.pixels, bytes: new Uint8ClampedArray(4) }, destination),
  ).toThrow("invalid byte layout");
});

it("binds SVG raster extent and source revisions without changing bucket selection", () => {
  const layer = createLayerForComposition("image", createBlankComposition());
  layer.size = [400, 200];
  const a = prepareSvgRaster(layer, footage, 0, "same-locator", 1, 4096);
  const reused = prepareSvgRaster(layer, footage, 1, "same-locator", 1, 4096);
  expect(reused).toEqual(a);
  const larger = prepareSvgRaster(layer, footage, 0, "same-locator", 8, 4096);
  expect(larger.target.width).toBeGreaterThan(a.target.width);
  expect(larger.identity).not.toEqual(a.identity);
  expect(readRasterBounds(larger.identity.sample)).toEqual({
    x: 0,
    y: 0,
    width: larger.target.width,
    height: larger.target.height,
  });
  const replaced = prepareSvgRaster(
    layer,
    { ...footage, contentIdentity: "asset-version-2" },
    0,
    "same-locator",
    1,
    4096,
  );
  expect(replaced.source).not.toBe(a.source);
  expect(replaced.identity).not.toEqual(a.identity);
});
