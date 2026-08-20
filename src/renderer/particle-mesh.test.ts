import { describe, expect, it } from "vitest";
import {
  needsParticleStorageGrowth,
  PARTICLE_BUFFER_STRIDE_BYTES,
  PARTICLE_MESH_VERTEX_COUNT,
  particleMeshRenderShader,
  particlePipelineDescriptor,
  planParticleRendering,
} from "./particle-mesh";

describe("GPU mesh particle rendering", () => {
  it("expands a cube per compacted GPU particle without a CPU vertex buffer", () => {
    expect(PARTICLE_MESH_VERTEX_COUNT).toBe(36);
    expect(PARTICLE_BUFFER_STRIDE_BYTES).toBe(48);
    expect(particleMeshRenderShader).toContain("@builtin(instance_index) instance");
    expect(particleMeshRenderShader).toContain("let particle = particles[instance]");
    expect(particleMeshRenderShader).toContain("particle_cube_surface(vertex)");
  });

  it("writes real rotated normals and depth while preserving color over life", () => {
    expect(particleMeshRenderShader).toContain(
      "particle_mesh_clip(particle.current.xyz, particle.current.w, local)",
    );
    expect(particleMeshRenderShader).toContain("output.normal = normalize");
    expect(particleMeshRenderShader).toContain(
      "mix(simulation.start_color, simulation.end_color, age)",
    );
  });

  it("caps mesh vertex work and grows storage only to a bounded power-of-two plan", () => {
    expect(planParticleRendering(100_000, "mesh", 512)).toMatchObject({
      effectiveCount: 100_000,
      capacity: 131_072,
      estimatedBytes: 6_291_456,
      lodApplied: false,
    });
    expect(planParticleRendering(1_000_000, "mesh", 512)).toMatchObject({
      effectiveCount: 131_072,
      capacity: 131_072,
      lodApplied: true,
    });
    expect(planParticleRendering(1_000_000, "mesh", 64).effectiveCount).toBe(16_384);
    expect(planParticleRendering(1_000_000, "billboard", 512).effectiveCount).toBe(1_000_000);
    expect(needsParticleStorageGrowth(131_072, 16_384)).toBe(false);
    expect(needsParticleStorageGrowth(131_072, 262_144)).toBe(true);
  });

  it("shares depth and blend descriptor truth across runtime and precompile callers", () => {
    const module = {} as GPUShaderModule;
    const normal = particlePipelineDescriptor("mesh", module, "rgba16float", "auto", "normal");
    const multiply = particlePipelineDescriptor("mesh", module, "rgba16float", "auto", "multiply");
    expect(normal.depthStencil).toMatchObject({
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    });
    expect(normal.fragment?.targets[0]).toMatchObject({
      blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } },
    });
    expect(multiply.fragment?.targets[0]).toMatchObject({
      blend: { color: { srcFactor: "dst", dstFactor: "zero" } },
    });
  });
});
