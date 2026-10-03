import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { layerCompositeShader } from "../compositing/layer-composite";
import { motionBlurShader, planMotionBlurTextures } from "../compositing/motion-blur-renderer";
import { precompositionSurfaceShader } from "../compositing/precomposition-surface-renderer";
import { blurDownsampleShader, brightpassDownsampleShader } from "../effects/blur-pyramid";
import { depthEffectsShader } from "../effects/depth-effects";
import { surfacePostEffectsShader } from "../effects/surface-post-effects";
import { sharedShaders } from "./shared-shader-catalog";

describe("shared compositing shader extraction", () => {
  it.each([
    [
      "blend",
      layerCompositeShader,
      "38fcd5b925fd149956c9963a8fcebb5551f5f67e449e64ac3111c1488b01fe09",
    ],
    [
      "precomposition",
      precompositionSurfaceShader,
      "b07d173aa7731e51b74ff9ebe19d085262827846bb1197531cf3d071a50646a1",
    ],
    [
      "blur",
      blurDownsampleShader,
      "ed080d4fb08e213f86dd46e2faaab6e4948e19f1f60b520a3a64e3bf4dc261df",
    ],
    [
      "brightpass",
      brightpassDownsampleShader,
      "833785bf79020f17a6d0b95d90a6ea2f26405243e46e810ae406dbdb731dc269",
    ],
    [
      "depth",
      depthEffectsShader,
      "ddddc601f5e1b4b0545a301497b9f24ae843bab3b93d0a2a4a8246364dd702d2",
    ],
    [
      "surface",
      surfacePostEffectsShader,
      "c6895a71dfa1243824953b090b304705f1f712f02821cdef53b61693fd7131c9",
    ],
  ])("preserves the original %s shader's expanded bytes", (_name, source, expectedHash) => {
    expect(createHash("sha256").update(source).digest("hex")).toBe(expectedHash);
  });

  it("changes only motion-blur tile literals into a typed override with the same host size", () => {
    expect(sharedShaders.pipelineConstants("motion-blur")).toEqual({ tile_extent: 16 });
    expect(motionBlurShader.match(/i32\(tile_extent\)/g)).toHaveLength(4);
    expect(motionBlurShader.match(/override tile_extent: u32 = 16u;/g)).toHaveLength(1);
    const original = motionBlurShader
      .replace(/^override tile_extent: u32 = 16u;\n/m, "")
      .replace(/i32\(tile_extent\)/g, "16");
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "49adb1943482bcc5c05bba7871530789713394162bae2ffcd0a917b708ee42f4",
    );
    expect(planMotionBlurTextures(17, 33)).toMatchObject({ tileWidth: 2, tileHeight: 3 });
  });
});
