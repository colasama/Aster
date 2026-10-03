import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { audioAnalysisAbiWgsl } from "../../core/audio/audio-analysis-frame";
import {
  particleGeneratorComputeShader,
  particleGeneratorRenderShader,
} from "../scene/bundled-particle-generator";
import { sceneGeneratorAbiWgsl } from "../scene/scene-generator-abi";
import { textMotionBlurRasterShader } from "../text/text-motion-blur-raster-cache";
import { sharedShaders } from "./shared-shader-catalog";

describe("shared generator, audio, text and diagnostic shaders", () => {
  it.each([
    ["scene-generator-abi", "d473e7dc4529727fc20f6d4736ac0faa75023f7b3261aa0f5653a6c04cae76a7"],
    ["audio-analysis-abi", "62f62065792d3d2e37db6abd3ba68350ed21007c35f0b978c7aefdcc529a66b9"],
    ["particle-compute", "8e9b65c7e2fbab32928cfe9028693c81b6b3aa562e3d446992533a26d2433e8b"],
    ["particle-render", "2ad720ba4ee2d2b08517d9ff955d973a0ca360438062b19716ab14c44240cf77"],
    ["text-motion-blur-raster", "8091f9803a1dcf9ab56af3a563510b04c66aef859c2c13d03f1e4e0304424a58"],
    ["diagnostic-scene", "96aad590904c84da9adbc90158e37921d3465c1771ef0264544790264727d8d9"],
    ["diagnostic-float", "47d66552a67133c2fe2e40fa887c7cc79a71322648d3c45cfac9711c88f46aec"],
    ["diagnostic-uint", "ee9105a349526211870ec6e3752fa685d8831bf3800dfbafadc8870c20e61454"],
  ])("preserves the original expanded bytes of %s", (program, expectedHash) => {
    expect(createHash("sha256").update(sharedShaders.source(program)).digest("hex")).toBe(
      expectedHash,
    );
  });

  it.each([
    ["scene-generator-abi", sceneGeneratorAbiWgsl],
    ["audio-analysis-abi", audioAnalysisAbiWgsl],
    ["particle-compute", particleGeneratorComputeShader],
    ["particle-render", particleGeneratorRenderShader],
    ["text-motion-blur-raster", textMotionBlurRasterShader],
  ])("keeps the public %s export equal to the shared source", (program, source) => {
    expect(source).toBe(sharedShaders.source(program));
  });
});
