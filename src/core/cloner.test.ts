import { describe, expect, it } from "vitest";
import {
  CLONER_INSTANCE_FLOATS,
  CLONER_INSTANCE_OFFSETS,
  type ClonerSettings,
  composeClonerTransform,
  evaluateCloner,
  normalizeClonerSettings,
  validateClonerSettings,
} from "./cloner";

describe("cloner evaluation", () => {
  it("centers grid clones and packs vec4-aligned GPU instance records", () => {
    const evaluated = evaluateCloner({
      distribution: { kind: "grid", count: [3, 2, 1], spacing: [10, 20, 30] },
      effectors: [],
    });

    expect(evaluated.instances).toHaveLength(6);
    expect(evaluated.instances[0].position).toEqual([-10, -10, 0]);
    expect(evaluated.instances[5].position).toEqual([10, 10, 0]);
    expect(evaluated.instanceData).toHaveLength(6 * CLONER_INSTANCE_FLOATS);
    expect(evaluated.instanceData[CLONER_INSTANCE_OFFSETS.scale]).toBe(1);
    expect(evaluated.instanceData[CLONER_INSTANCE_OFFSETS.metadata + 3]).toBe(1);
  });

  it("does not duplicate the radial endpoint for a closed ring", () => {
    const evaluated = evaluateCloner({
      distribution: {
        kind: "radial",
        count: 4,
        radius: 100,
        startAngle: 0,
        endAngle: 360,
        axis: "z",
        alignRotation: true,
      },
      effectors: [],
    });

    expect(evaluated.instances.map((instance) => instance.position)).toEqual([
      [100, 0, 0],
      [expect.closeTo(0), 100, 0],
      [-100, expect.closeTo(0), 0],
      [expect.closeTo(0), -100, 0],
    ]);
    expect(evaluated.instances.map((instance) => instance.rotation[2])).toEqual([0, 90, 180, 270]);
  });

  it("applies position, scale, and rotation effectors in declaration order", () => {
    const settings: ClonerSettings = {
      distribution: { kind: "grid", count: [1, 1, 1], spacing: [0, 0, 0] },
      effectors: [
        {
          id: "position",
          kind: "position",
          enabled: true,
          strength: 0.5,
          value: [20, -10, 4],
        },
        {
          id: "scale",
          kind: "scale",
          enabled: true,
          strength: 0.5,
          value: [200, 50, 100],
        },
        {
          id: "rotation",
          kind: "rotation",
          enabled: true,
          strength: 0.25,
          value: [40, 80, 120],
        },
      ],
    };

    const [instance] = evaluateCloner(settings).instances;
    expect(instance.position).toEqual([10, -5, 2]);
    expect(instance.scale).toEqual([150, 75, 100]);
    expect(instance.rotation).toEqual([10, 20, 30]);
  });

  it("keeps random effectors reproducible per seed and instance", () => {
    const settings: ClonerSettings = {
      distribution: { kind: "grid", count: [16, 1, 1], spacing: [1, 0, 0] },
      effectors: [
        {
          id: "random",
          kind: "random",
          enabled: true,
          strength: 1,
          seed: 42,
          position: [30, 20, 10],
          scale: [25, 25, 25],
          rotation: [180, 90, 45],
        },
      ],
    };

    const first = evaluateCloner(settings);
    const second = evaluateCloner(structuredClone(settings));
    expect(second.instances).toEqual(first.instances);
    expect(second.instanceData).toEqual(first.instanceData);
    const changed = structuredClone(settings);
    const random = changed.effectors[0];
    if (random.kind !== "random") throw new Error("Expected random effector");
    random.seed = 43;
    expect(evaluateCloner(changed).instances).not.toEqual(first.instances);
  });

  it("maps clone-local offsets through the source 3D transform", () => {
    const transformed = composeClonerTransform(
      {
        position: [100, 200, 300],
        rotation: [0, 0, 90],
        scale: [200, 100, 50],
        anchor: [0, 0, 0],
        opacity: 0.8,
      },
      { index: 0, position: [10, 0, 20], rotation: [1, 2, 3], scale: [50, 200, 100] },
    );

    expect(transformed.position[0]).toBeCloseTo(100);
    expect(transformed.position[1]).toBeCloseTo(220);
    expect(transformed.position[2]).toBeCloseTo(310);
    expect(transformed.rotation).toEqual([1, 2, 93]);
    expect(transformed.scale).toEqual([100, 200, 50]);
  });

  it("bounds malformed instance counts before allocating", () => {
    expect(
      evaluateCloner({
        distribution: { kind: "grid", count: [10_000, 10_000, 10_000], spacing: [1, 1, 1] },
        effectors: [],
      }).instances,
    ).toHaveLength(65_536);
  });

  it("normalizes operation input and rejects invalid persisted settings", () => {
    const normalized = normalizeClonerSettings({
      distribution: { kind: "grid", count: [0, 900, 2.9], spacing: [Infinity, 2_000_000, -4] },
      effectors: [],
    });
    expect(normalized.distribution).toEqual({
      kind: "grid",
      count: [1, 512, 2],
      spacing: [0, 1_000_000, -4],
    });
    expect(() =>
      validateClonerSettings({
        distribution: { kind: "grid", count: [512, 512, 512], spacing: [1, 1, 1] },
        effectors: [],
      }),
    ).toThrow("exceeds 65536 instances");
    expect(() =>
      validateClonerSettings({
        distribution: {
          kind: "radial",
          count: 8,
          radius: 100,
          startAngle: 0,
          endAngle: 360,
          axis: "z",
          alignRotation: false,
        },
        effectors: [
          {
            id: "random",
            kind: "random",
            enabled: true,
            strength: 1,
            seed: 1,
            position: [-1, 1, 1],
            scale: [1, 1, 1],
            rotation: [1, 1, 1],
          },
        ],
      }),
    ).toThrow("amplitudes must not be negative");
  });
});
