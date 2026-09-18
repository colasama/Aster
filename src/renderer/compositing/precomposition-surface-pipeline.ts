import { BLEND_MODES, type BlendMode } from "../../core/types";
import { IMAGE_VERTEX_BUFFERS } from "../scene/scene-pipelines";
import { FIXED_BLEND_MODES, gpuBlendState } from "./blend-state";
import { createCapturablePipeline } from "./transparency-pipeline";

const SURFACE_FORMAT: GPUTextureFormat = "rgba16float";

export function createSurfacePipelines(
  device: GPUDevice,
  mediaLayout: GPUBindGroupLayout,
): Record<BlendMode, GPURenderPipeline> {
  const module = device.createShaderModule({
    label: "Premultiplied precomposition surface shader",
    code: precompositionSurfaceShader,
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [mediaLayout] });
  const pipelines = Object.fromEntries(
    FIXED_BLEND_MODES.map((blendMode) => [
      blendMode,
      createCapturablePipeline(
        device,
        {
          label: `Precomposition 3D surface · ${blendMode}`,
          layout,
          vertex: { module, entryPoint: "vertex_main", buffers: IMAGE_VERTEX_BUFFERS },
          fragment: {
            module,
            entryPoint: "fragment_main",
            targets: [{ format: SURFACE_FORMAT, blend: gpuBlendState(blendMode) }],
          },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            format: "depth24plus",
            depthWriteEnabled: true,
            depthCompare: "less-equal",
          },
        },
        precompositionSurfaceShader,
      ),
    ]),
  );
  return Object.fromEntries(
    BLEND_MODES.map((mode) => [mode, pipelines[mode] ?? pipelines.normal]),
  ) as Record<BlendMode, GPURenderPipeline>;
}

export const precompositionSurfaceShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}
@group(0) @binding(0) var surface_texture: texture_2d<f32>;
@group(0) @binding(1) var surface_sampler: sampler;

@vertex fn vertex_main(
  @location(0) position: vec3f,
  @location(15) clip_w: f32,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position * clip_w, clip_w);
  output.uv = uv;
  output.color = color;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(surface_texture, surface_sampler, input.uv);
  let alpha = sampled.a * input.color.a;
  if (alpha <= 0.00001) { discard; }
  return vec4f(
    sampled.rgb * input.color.rgb * input.color.a,
    alpha,
  );
}
`;
