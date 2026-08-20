import type { BlendMode } from "../core/types";
import {
  PARTICLE_MESH_BLEND_MODES,
  particleMeshRenderShader,
  particlePipelineDescriptor,
} from "./particle-mesh";
import { particleRenderShader, postProcessShader } from "./shaders";

export function createParticleBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: "Shared particle render resources",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    ],
  });
}

export function createParticlePipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  bindGroupLayout: GPUBindGroupLayout,
): { billboard: GPURenderPipeline; mesh: Record<BlendMode, GPURenderPipeline> } {
  const layout = device.createPipelineLayout({
    label: "Particle render pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });
  const billboardModule = device.createShaderModule({
    label: "Particle billboard shader",
    code: particleRenderShader,
  });
  const meshModule = device.createShaderModule({
    label: "Particle mesh shader",
    code: particleMeshRenderShader,
  });
  const mesh = Object.fromEntries(
    PARTICLE_MESH_BLEND_MODES.map((blendMode) => [
      blendMode,
      device.createRenderPipeline(
        particlePipelineDescriptor("mesh", meshModule, format, layout, blendMode),
      ),
    ]),
  ) as Record<BlendMode, GPURenderPipeline>;
  return {
    billboard: device.createRenderPipeline(
      particlePipelineDescriptor("billboard", billboardModule, format, layout),
    ),
    mesh,
  };
}

export function createPostPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const module = device.createShaderModule({
    label: "HDR fused effects and display shader",
    code: postProcessShader,
  });
  return device.createRenderPipeline({
    label: "HDR post-process and ACES output",
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}
