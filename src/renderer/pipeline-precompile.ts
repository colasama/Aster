import { depthEffectsShader } from "./depth-effects";
import {
  PARTICLE_MESH_BLEND_MODES,
  particleMeshRenderShader,
  particlePipelineDescriptor,
} from "./particle-mesh";
import {
  IMAGE_VERTEX_BUFFERS,
  SHADOW_VERTEX_BUFFERS,
  SHAPE_VERTEX_BUFFERS,
} from "./scene-pipelines";
import {
  imageShader,
  particleComputeShader,
  particleRenderShader,
  postProcessShader,
  shadowShader,
  shapeShader,
  textureCompositeShader,
} from "./shaders";

const SCENE_FORMAT: GPUTextureFormat = "rgba16float";

export interface PipelinePrecompileReport {
  count: number;
  durationMs: number;
}

export async function precompileGpuPipelines(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
): Promise<PipelinePrecompileReport> {
  const started = performance.now();
  const module = (label: string, code: string) => device.createShaderModule({ label, code });
  const shape = module("Async precompile · shape", shapeShader);
  const image = module("Async precompile · image", imageShader);
  const shadow = module("Async precompile · shadow", shadowShader);
  const particles = module("Async precompile · particle render", particleRenderShader);
  const meshParticles = module("Async precompile · particle mesh render", particleMeshRenderShader);
  const compute = module("Async precompile · particle compute", particleComputeShader);
  const post = module("Async precompile · post process", postProcessShader);
  const depthEffects = module("Async precompile · depth effects", depthEffectsShader);
  const composite = module("Async precompile · texture composite", textureCompositeShader);
  await Promise.all([
    device.createRenderPipelineAsync({
      label: "Async precompile · shape pipeline",
      layout: "auto",
      vertex: { module: shape, entryPoint: "vertex_main", buffers: SHAPE_VERTEX_BUFFERS },
      fragment: { module: shape, entryPoint: "fragment_main", targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    }),
    device.createRenderPipelineAsync({
      label: "Async precompile · image pipeline",
      layout: "auto",
      vertex: { module: image, entryPoint: "vertex_main", buffers: IMAGE_VERTEX_BUFFERS },
      fragment: { module: image, entryPoint: "fragment_main", targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    }),
    device.createRenderPipelineAsync({
      label: "Async precompile · shadow pipeline",
      layout: "auto",
      vertex: { module: shadow, entryPoint: "vertex_main", buffers: SHADOW_VERTEX_BUFFERS },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    }),
    device.createRenderPipelineAsync(
      particlePipelineDescriptor("billboard", particles, SCENE_FORMAT, "auto"),
    ),
    ...PARTICLE_MESH_BLEND_MODES.map((blendMode) =>
      device.createRenderPipelineAsync(
        particlePipelineDescriptor("mesh", meshParticles, SCENE_FORMAT, "auto", blendMode),
      ),
    ),
    device.createRenderPipelineAsync(fullscreenDescriptor("post process", post, canvasFormat)),
    device.createRenderPipelineAsync(
      fullscreenDescriptor("depth effects", depthEffects, canvasFormat),
    ),
    device.createRenderPipelineAsync(
      fullscreenDescriptor("texture composite", composite, SCENE_FORMAT),
    ),
    device.createComputePipelineAsync({
      label: "Async precompile · particle compute pipeline",
      layout: "auto",
      compute: { module: compute, entryPoint: "compute_main" },
    }),
  ]);
  return { count: 8 + PARTICLE_MESH_BLEND_MODES.length, durationMs: performance.now() - started };
}

function fullscreenDescriptor(
  label: string,
  module: GPUShaderModule,
  format: GPUTextureFormat,
): GPURenderPipelineDescriptor {
  return {
    label: `Async precompile · ${label} pipeline`,
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  };
}
