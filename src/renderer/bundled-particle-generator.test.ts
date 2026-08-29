import { describe, expect, it } from "vitest";
import {
  bundledParticleDefinition,
  bundledParticleGraph,
  bundledParticleManifest,
  bundledParticleParameters,
  particleGeneratorComputeShader,
  particleGeneratorRenderShader,
} from "./bundled-particle-generator";
import { planGeneratorCapacity } from "./scene-generator-host";

describe("bundled particle scene-generator plugin", () => {
  it("declares the bounded GPU graph consumed by the generic host", () => {
    expect(bundledParticleGraph).toMatchObject({
      api_version: 1,
      node_type: "particle_system",
      capacity_parameter: "count",
      max_instances: 1_000_000,
      instance_stride: 48,
      render_parameter: "renderMode",
    });
    expect(bundledParticleGraph.compute_passes).toHaveLength(1);
    expect(bundledParticleManifest.plugin.kind).toBe("scene_generator");
    expect(bundledParticleGraph.render_variants.map((variant) => variant.id)).toEqual([
      "billboard",
      "streak",
      "mesh",
    ]);
    expect(bundledParticleGraph.render_variants.every((variant) => variant.auxiliary)).toBe(true);
    expect(bundledParticleParameters).toHaveLength(23);
    expect(bundledParticleDefinition.shaderSources).toEqual({
      "particle-compute.wgsl": particleGeneratorComputeShader,
      "particle-render.wgsl": particleGeneratorRenderShader,
    });
  });

  it("evaluates deterministic state from local time and writes an indirect draw", () => {
    expect(particleGeneratorComputeShader).toContain("aster_context.local_time / lifetime");
    expect(particleGeneratorComputeShader).toContain("aster_context.frame_duration");
    expect(particleGeneratorComputeShader).toContain("cycle_number == previous_cycle_number");
    expect(particleGeneratorComputeShader).toContain("atomicAdd(&aster_draw.instance_count, 1u)");
    expect(particleGeneratorComputeShader).toContain("generator_clip(current)");
    expect(particleGeneratorComputeShader).not.toContain("delta_time");
  });

  it("implements Beauty and auxiliary output for all render variants through ABI v1", () => {
    for (const mode of ["billboard", "streak", "mesh"])
      expect(particleGeneratorRenderShader).toContain(`@vertex fn ${mode}_vertex`);
    expect(particleGeneratorRenderShader).toContain("aster_context.ids.x");
    expect(particleGeneratorRenderShader).toContain("aster_context.ids.y");
    expect(particleGeneratorRenderShader).toContain("output.motion_vector = input.motion");
    expect(particleGeneratorRenderShader).toContain("aster_context.camera_position");
    expect(particleGeneratorRenderShader).toContain("aster_context.layer_position_opacity");
  });

  it("applies generic memory and vertex-work LOD without particle-specific host rules", () => {
    expect(planGeneratorCapacity(1_000_000, 1_000_000, 48, 6, 512)).toMatchObject({
      effectiveCount: 1_000_000,
      capacity: 1_000_000,
    });
    expect(planGeneratorCapacity(1_000_000, 1_000_000, 48, 36, 512).effectiveCount).toBe(174_762);
    expect(planGeneratorCapacity(1_000_000, 1_000_000, 48, 36, 64).effectiveCount).toBe(21_845);
    expect(planGeneratorCapacity(10_000, 10_000, 16, 1, 512, 8_192, 320)).toEqual({
      effectiveCount: 320,
      capacity: 512,
    });
  });
});
