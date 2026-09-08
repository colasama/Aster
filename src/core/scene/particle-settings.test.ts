import { describe, expect, it } from "vitest";
import {
  assertParticleSettings,
  createDefaultParticleSettings,
  normalizeParticleSettings,
  PARTICLE_SETTING_KEYS,
} from "./particle-settings";

describe("strict GPU particle settings", () => {
  it("defines a complete deterministic MVP document", () => {
    const settings = createDefaultParticleSettings();
    expect(Object.keys(settings)).toEqual(PARTICLE_SETTING_KEYS);
    expect(() => assertParticleSettings(settings)).not.toThrow();
    expect(settings).toMatchObject({
      count: 100_000,
      emitterShape: "sphere",
      emitterPosition: [0, 0, 0],
      velocity: [0.16, 0.08, 0],
      gravity: [0, -0.035, 0],
      startOpacity: 0.65,
      endOpacity: 0,
    });
  });

  it("normalizes non-finite, vector, work, and appearance bounds", () => {
    const settings = createDefaultParticleSettings();
    const result = normalizeParticleSettings({
      ...settings,
      count: 9_000_000,
      seed: Number.NaN,
      emitterPosition: [-20, Number.POSITIVE_INFINITY, 20],
      emitterSize: [-1, 2, 20],
      velocity: [-20, 2, 20],
      gravity: [-20, 2, 20],
      drag: 20,
      turbulence: -1,
      startColor: [-1, 0.5, 20],
      endOpacity: 2,
      streakLength: 0,
    });
    expect(result).toMatchObject({
      count: 1_000_000,
      seed: 13_337,
      emitterPosition: [-4, 0, 4],
      emitterSize: [0, 2, 8],
      velocity: [-10, 2, 10],
      gravity: [-10, 2, 10],
      drag: 10,
      turbulence: 0,
      startColor: [0, 0.5, 16],
      endOpacity: 1,
      streakLength: 0.01,
    });
    expect(
      normalizeParticleSettings({
        ...settings,
        velocity: undefined,
      } as unknown as Parameters<typeof normalizeParticleSettings>[0]).velocity,
    ).toEqual(settings.velocity);
  });

  it("rejects missing, unknown, malformed, and invalid enum fields", () => {
    const settings = createDefaultParticleSettings() as unknown as Record<string, unknown>;
    delete settings.gravity;
    expect(() => assertParticleSettings(settings, "layer.particle")).toThrow(
      "layer.particle.gravity is required",
    );
    settings.gravity = [0, -0.1, 0];
    settings.oldAcceleration = -0.1;
    expect(() => assertParticleSettings(settings, "layer.particle")).toThrow(
      "oldAcceleration is not supported",
    );
    delete settings.oldAcceleration;
    settings.emitterShape = "cone";
    expect(() => assertParticleSettings(settings)).toThrow("emitterShape");
    settings.emitterShape = "box";
    settings.startColor = [1, 1];
    expect(() => assertParticleSettings(settings)).toThrow("exactly three channels");
  });
});
