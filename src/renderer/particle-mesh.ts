import type { BlendMode } from "../core/types";
import { gpuBlendState } from "./blend-state";
import { PARTICLE_STORAGE_STRIDE_BYTES } from "./particle-system";

export type ParticleRenderMode = "billboard" | "streak" | "mesh";

export const MAX_PARTICLE_CAPACITY = 1_000_000;
export const PARTICLE_BUFFER_STRIDE_BYTES = PARTICLE_STORAGE_STRIDE_BYTES;
export const PARTICLE_BILLBOARD_VERTEX_COUNT = 6;
export const PARTICLE_MESH_VERTEX_COUNT = 36;
export const PARTICLE_MESH_BLEND_MODES: readonly BlendMode[] = [
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
];

export interface ParticleRenderPlan {
  requestedCount: number;
  effectiveCount: number;
  capacity: number;
  estimatedBytes: number;
  lodApplied: boolean;
}

/** Bounds storage and vertex work against the configured GPU budget. */
export function planParticleRendering(
  requestedCount: number,
  renderMode: ParticleRenderMode,
  budgetMb = 512,
): ParticleRenderPlan {
  const finiteRequestedCount = Number.isFinite(requestedCount) ? requestedCount : 1;
  const requested = Math.max(1, Math.min(MAX_PARTICLE_CAPACITY, Math.round(finiteRequestedCount)));
  const boundedBudgetMb = Number.isFinite(budgetMb) ? Math.max(16, budgetMb) : 512;
  const memoryLimit = Math.max(
    1_024,
    Math.floor((boundedBudgetMb * 1024 * 1024 * 0.125) / PARTICLE_BUFFER_STRIDE_BYTES),
  );
  const vertexLimit =
    renderMode === "mesh"
      ? Math.max(16_384, Math.min(131_072, Math.floor(boundedBudgetMb * 256)))
      : MAX_PARTICLE_CAPACITY;
  const effectiveCount = Math.min(requested, memoryLimit, vertexLimit);
  const capacity = Math.min(
    MAX_PARTICLE_CAPACITY,
    2 ** Math.ceil(Math.log2(Math.max(1_024, effectiveCount))),
  );
  return {
    requestedCount: requested,
    effectiveCount,
    capacity,
    estimatedBytes: capacity * PARTICLE_BUFFER_STRIDE_BYTES,
    lodApplied: effectiveCount < requested,
  };
}

export function particleVertexCount(renderMode: ParticleRenderMode): number {
  return renderMode === "mesh" ? PARTICLE_MESH_VERTEX_COUNT : PARTICLE_BILLBOARD_VERTEX_COUNT;
}

export function needsParticleStorageGrowth(currentCapacity: number, requiredCapacity: number) {
  // Lower budgets cap effective work without reallocating an already-valid GPU buffer every frame.
  return requiredCapacity > currentCapacity;
}

export function particlePipelineDescriptor(
  mode: ParticleRenderMode,
  module: GPUShaderModule,
  format: GPUTextureFormat,
  layout: GPUPipelineLayout | "auto",
  blendMode: BlendMode = "add",
): GPURenderPipelineDescriptor {
  return {
    label: `GPU-culled ${mode} particle renderer · ${blendMode}`,
    layout,
    vertex: { module, entryPoint: "vertex_main" },
    fragment: {
      module,
      entryPoint: "fragment_main",
      targets: [{ format, blend: gpuBlendState(mode === "mesh" ? blendMode : "add") }],
    },
    primitive: { topology: "triangle-list", cullMode: mode === "mesh" ? "back" : "none" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: mode === "mesh",
      depthCompare: mode === "mesh" ? "less-equal" : "always",
    },
  };
}

/** Shared cube expansion and clip-depth truth for Beauty and auxiliary passes. */
export const particleMeshGeometryShader = /* wgsl */ `
struct CubeSurface { position: vec3f, normal: vec3f }

fn particle_cube_surface(vertex: u32) -> CubeSurface {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let normals = array<vec3f, 6>(
    vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0),
    vec3f(0.0, 1.0, 0.0), vec3f(0.0, -1.0, 0.0),
    vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0)
  );
  let tangents = array<vec3f, 6>(
    vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, 1.0),
    vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0),
    vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0)
  );
  let bitangents = array<vec3f, 6>(
    vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, -1.0),
    vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0)
  );
  let face = vertex / 6u;
  let corner = corners[vertex % 6u];
  var surface: CubeSurface;
  surface.normal = normals[face];
  surface.position = surface.normal + tangents[face] * corner.x + bitangents[face] * corner.y;
  return surface;
}

fn particle_orient(value: vec3f, cosine: f32, sine: f32) -> vec3f {
  let around_z = vec3f(
    value.x * cosine - value.y * sine,
    value.x * sine + value.y * cosine,
    value.z,
  );
  return vec3f(
    around_z.x,
    around_z.y * cosine - around_z.z * sine,
    around_z.y * sine + around_z.z * cosine,
  );
}

fn particle_mesh_clip(position: vec3f, size_pixels: f32, local: vec3f) -> vec3f {
  let size = size_pixels / 900.0;
  let center_depth = clamp(0.5 - position.z * 0.1, 0.08, 0.92);
  return vec3f(
    position.xy + local.xy * size,
    clamp(center_depth + local.z * size, 0.001, 0.999),
  );
}
`;

/** GPU-expanded cube particles sourced directly from compacted simulation storage. */
export const particleMeshRenderShader = /* wgsl */ `
struct Simulation {
  header: vec4f, lifecycle: vec4f,
  emitter_position_shape: vec4f, emitter_size_spread: vec4f,
  velocity_scale: vec4f, gravity_streak: vec4f, appearance: vec4f,
  start_color: vec4f, end_color: vec4f,
}
struct Particle { current: vec4f, previous: vec4f, appearance: vec4f }
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) normal: vec3f,
}
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> simulation: Simulation;

${particleMeshGeometryShader}

@vertex fn vertex_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOutput {
  let particle = particles[instance];
  let age = particle.appearance.x;
  let rotation_cos = particle.appearance.y;
  let rotation_sin = particle.appearance.z;
  let surface = particle_cube_surface(vertex);
  let local = particle_orient(surface.position, rotation_cos, rotation_sin);
  let clip = particle_mesh_clip(particle.current.xyz, particle.current.w, local);
  var output: VertexOutput;
  output.position = vec4f(clip, 1.0);
  output.color = mix(simulation.start_color, simulation.end_color, age);
  output.normal = normalize(particle_orient(surface.normal, rotation_cos, rotation_sin));
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let light = normalize(vec3f(0.35, -0.55, 0.76));
  let diffuse = 0.2 + 0.8 * max(dot(normalize(input.normal), light), 0.0);
  let alpha = input.color.a;
  return vec4f(input.color.rgb * diffuse * alpha, alpha);
}
`;
