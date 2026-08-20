import { describe, expect, it } from "vitest";
import { encodeRenderId } from "./render-buffers";
import {
  buildSurfacePostUniforms,
  SURFACE_POST_UNIFORM_BYTES,
  selectedRenderId,
  surfacePostEffectsShader,
} from "./surface-post-effects";

describe("surface-data GPU post effects", () => {
  it("packs one stable root selection ID and a bounded normalized shutter scale", () => {
    const rootId = selectedRenderId(
      [{ selectionId: "hero" }, { selectionId: "hero" }, { selectionId: "background" }],
      "hero",
    );
    const data = buildSurfacePostUniforms("selectionIsolation", 1920.8, 1080.2, rootId, 8);
    expect(data.byteLength).toBe(SURFACE_POST_UNIFORM_BYTES);
    expect([...new Float32Array(data, 0, 2)]).toEqual([1920, 1080]);
    expect([...new Uint32Array(data, 8, 2)]).toEqual([1, encodeRenderId("hero")]);
    expect(new Float32Array(data, 16, 1)[0]).toBe(4);
    expect(selectedRenderId([], undefined)).toBe(0);
    expect(selectedRenderId([{ selectionId: "background" }], "hero")).toBe(0);
    expect(selectedRenderId([], "particles", "particles")).toBe(encodeRenderId("particles"));
    expect(selectedRenderId([], "particles", "other-particles")).toBe(0);
  });

  it("packs vector blur independently of selection and sanitizes invalid inputs", () => {
    const data = buildSurfacePostUniforms("vectorMotionBlur", 0, Number.NaN, -1, Number.NaN);
    expect([...new Float32Array(data, 0, 2)]).toEqual([1, 1]);
    expect([...new Uint32Array(data, 8, 2)]).toEqual([2, 0]);
    expect(new Float32Array(data, 16, 1)[0]).toBe(0);
  });

  it("finds a visible root selection beyond the former 32-clone lookup bound", () => {
    const batches = Array.from({ length: 65_536 }, (_, index) => ({
      selectionId: index === 65_535 ? "hero" : "other",
    }));
    expect(selectedRenderId(batches, "hero")).toBe(encodeRenderId("hero"));
  });

  it("samples typed MRT data and handles premultiplied HDR and blurred alpha safely", () => {
    expect(surfacePostEffectsShader).toContain("object_ids: texture_2d<u32>");
    expect(surfacePostEffectsShader).toContain("motion_vectors: texture_2d<f32>");
    expect(surfacePostEffectsShader).toContain("textureLoad(object_ids");
    expect(surfacePostEffectsShader).toContain("textureLoad(motion_vectors");
    expect(surfacePostEffectsShader).toContain("index < 9u");
    expect(surfacePostEffectsShader).toContain("settings.motion.x");
    expect(surfacePostEffectsShader).toContain("64.0 / max(pixel_length");
    expect(surfacePostEffectsShader).toContain("premultiplied.rgb / max(premultiplied.a");
    expect(surfacePostEffectsShader).toContain("accumulated += textureSampleLevel");
    expect(surfacePostEffectsShader).toContain("* premultiplied.a, premultiplied.a");
    expect(surfacePostEffectsShader).toContain("settings.selected_id != 0u");
  });
});
