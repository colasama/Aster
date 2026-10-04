import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EffectOpcode } from "../effects/effect-opcodes";
import { FLOATS_PER_EFFECT_OPERATION, MAX_EFFECT_OPERATIONS } from "../effects/effect-program";
import { buildPostProcessUniforms } from "../effects/post-process";
import { createPostPipeline } from "./runtime-pipelines";
import { postProcessShader } from "./shaders";
import { sharedShaders } from "./shared-shader-catalog";

describe("shared post-process shader", () => {
  it("pins the shared source and retains the generic catalog default", () => {
    const source = sharedShaders.source("post-process");
    expect(postProcessShader).toBe(source);
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "5323555f0dcad8d861f15dda7e04f31143888c0fc0a61fedd3f4cef8d4caac31",
    );
    expect(sharedShaders.pipelineConstants("post-process")).toEqual({ root_zero_operations: 0 });
  });

  it("preserves the host uniform, operation and eight-binding ABI", () => {
    const bindings = [
      ...postProcessShader.matchAll(/@group\((\d+)\) @binding\((\d+)\) ([^;]+);/g),
    ].map(([, group, binding, declaration]) => [Number(group), Number(binding), declaration]);
    expect(bindings).toEqual([
      [0, 0, "var hdr_scene: texture_2d<f32>"],
      [0, 1, "var linear_sampler: sampler"],
      [0, 2, "var<uniform> settings: PostProcess"],
      [0, 3, "var<storage, read> effect_ops: array<EffectOp>"],
      [0, 4, "var lut_texture: texture_3d<f32>"],
      [0, 5, "var lut_sampler: sampler"],
      [0, 6, "var blur_scene: texture_2d<f32>"],
      [0, 7, "var glow_scene: texture_2d<f32>"],
    ]);
    const uniforms = postProcessShader.match(/struct PostProcess \{([^}]+)\}/)?.[1];
    const operation = postProcessShader.match(/struct EffectOp \{([^}]+)\}/)?.[1];
    expect(uniforms?.match(/:\s*vec4f,/g)).toHaveLength(6);
    expect(operation?.match(/:\s*vec4f,/g)).toHaveLength(4);
    expect(buildPostProcessUniforms(320, 180, 0).byteLength).toBe(96);
    expect(FLOATS_PER_EFFECT_OPERATION * Float32Array.BYTES_PER_ELEMENT).toBe(64);
  });

  it("keeps both effect loops and mask branches aligned with CPU operation codes", () => {
    expect(EffectOpcode.MaskBegin).toBe(106);
    expect(EffectOpcode.MaskEnd).toBe(107);
    expect(MAX_EFFECT_OPERATIONS).toBe(64);
    const cases = [...postProcessShader.matchAll(/case (\d+)u:/g)].map((match) => Number(match[1]));
    expect(cases.filter((code) => code === EffectOpcode.MaskBegin)).toHaveLength(2);
    expect(cases.filter((code) => code === EffectOpcode.MaskEnd)).toHaveLength(2);
    const loops = [
      ...postProcessShader.matchAll(
        /for \(var index = 0u; index < (\d+)u; index \+= 1u\) \{\s*if \(index >= effect_count\)/g,
      ),
    ].map((match) => Number(match[1]));
    expect(loops).toEqual([MAX_EFFECT_OPERATIONS, MAX_EFFECT_OPERATIONS]);
  });

  it("passes the shared module to both stages of the production output pipeline", () => {
    const module = {} as GPUShaderModule;
    const pipeline = {} as GPURenderPipeline;
    const createShaderModule = vi
      .fn<(descriptor: GPUShaderModuleDescriptor) => GPUShaderModule>()
      .mockReturnValue(module);
    const createRenderPipeline = vi
      .fn<(descriptor: GPURenderPipelineDescriptor) => GPURenderPipeline>()
      .mockReturnValue(pipeline);
    const device = { createShaderModule, createRenderPipeline } as unknown as GPUDevice;

    expect(createPostPipeline(device, "rgba8unorm")).toBe(pipeline);
    expect(createShaderModule).toHaveBeenCalledExactlyOnceWith({
      label: "HDR fused effects and display shader",
      code: sharedShaders.source("post-process"),
    });
    expect(createRenderPipeline).toHaveBeenCalledExactlyOnceWith({
      label: "HDR post-process and sRGB output",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "fragment_main",
        constants: { root_zero_operations: 1 },
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  });
});
