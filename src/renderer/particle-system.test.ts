import { describe, expect, it } from "vitest";
import { createDefaultParticleSettings } from "../core/particle-settings";
import {
  buildParticleSimulationUniforms,
  PARTICLE_DETERMINISM,
  PARTICLE_STORAGE_STRIDE_BYTES,
  PARTICLE_UNIFORM_FLOATS,
  PARTICLE_WORKGROUP_SIZE,
  particleBillboardRenderShader,
  particleComputeShader,
  particleStreakRenderShader,
} from "./particle-system";

describe("time-addressable GPU particle field", () => {
  it("packs every simulation control into a bounded uniform block", () => {
    const settings = {
      ...createDefaultParticleSettings(),
      emitterShape: "ring" as const,
      emitterPosition: [0.1, -0.2, 0.3] as [number, number, number],
      emitterSize: [1, 2, 3] as [number, number, number],
      velocity: [0.4, 0.5, 0.6] as [number, number, number],
      gravity: [0, -0.2, 0.1] as [number, number, number],
      startColor: [2, 1, 0.5] as [number, number, number],
      endColor: [0.1, 0.2, 0.3] as [number, number, number],
    };
    const first = buildParticleSimulationUniforms(settings, 2.5, 16 / 9, 1 / 60, 100_000);
    const second = buildParticleSimulationUniforms(settings, 2.5, 16 / 9, 1 / 60, 100_000);
    expect(first).toEqual(second);
    expect(first).toHaveLength(PARTICLE_UNIFORM_FLOATS);
    expect(Array.from(first.slice(8, 11))).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(-0.2),
      expect.closeTo(0.3),
    ]);
    expect(first[11]).toBe(3);
    expect(first[0]).toBe(2.5);
    expect(first[2]).toBe(100_000);
    expect(first[31]).toBeCloseTo(settings.startOpacity);
    expect(first[35]).toBeCloseTo(settings.endOpacity);
  });

  it("evaluates each particle analytically without CPU state or frame stepping", () => {
    expect(PARTICLE_WORKGROUP_SIZE).toBe(256);
    expect(PARTICLE_STORAGE_STRIDE_BYTES).toBe(48);
    expect(particleComputeShader).toContain("integrated_motion");
    expect(particleComputeShader).toContain("exp(-drag * elapsed)");
    expect(particleComputeShader).toContain("simulation.header.x / lifetime");
    expect(particleComputeShader).toContain("atomicAdd(&particle_draw.instance_count, 1u)");
    expect(particleComputeShader).toContain("if f32(index) >= simulation.header.z { return; }");
    expect(particleComputeShader).not.toContain("delta_time");
    expect(particleComputeShader).toContain("cycle * 1013904223u");
    expect(particleComputeShader).toContain("cycle_number == previous_cycle_number");
    expect(particleComputeShader).not.toContain("age >= previous_age");
    expect(particleComputeShader).toContain("minimum_cosine = cos(clamp(");
    expect(particleComputeShader).toContain("tangent * (cos(azimuth) * sine)");
    expect(particleComputeShader).toContain("simulation.gravity_streak.w * continuous");
    expect(PARTICLE_DETERMINISM).toEqual({
      state: "absolute-time-per-slot",
      visibilityOrder: "gpu-compaction-unspecified",
    });
  });

  it("breaks motion continuity when a 1 fps sample spans twenty lifetimes", () => {
    const lifetime = 0.05;
    const slotPhase = 0.37;
    const cycleAt = (time: number) => Math.floor(time / lifetime + slotPhase);
    const currentCycle = cycleAt(1);
    const previousCycle = cycleAt(0);

    expect(currentCycle - previousCycle).toBe(20);
    expect(currentCycle).not.toBe(previousCycle);
    expect(particleComputeShader).toContain("let previous_phase_time =");
    expect(particleComputeShader).toContain(
      "let previous_cycle_number = floor(previous_phase_time)",
    );
  });

  it("implements all emitter shapes and GPU-only life appearance", () => {
    for (const shapeCode of ["shape == 1u", "shape == 2u", "shape == 3u", "shape == 4u"])
      expect(particleComputeShader).toContain(shapeCode);
    expect(particleBillboardRenderShader).toContain("life_color(particle.appearance.x)");
    expect(particleStreakRenderShader).toContain("particle.current.xy - particle.previous.xy");
    expect(particleStreakRenderShader).toContain("simulation.gravity_streak.w");
  });
});
