import { describe, expect, it } from "vitest";
import { validateProjectDocument } from "../../../src/core/project/validation/document";
import { createEffect, EFFECT_REGISTRY } from "../../../src/effects/registry";
import { compileEffectProgram } from "../../../src/renderer/effects/effect-program";
import { buildEffectCases } from "./effects";

describe("effect parity fixtures", () => {
  it("covers every registered effect with one enabled, compiled, bounded effect", () => {
    const cases = buildEffectCases();
    for (const definition of EFFECT_REGISTRY) {
      const entry = cases.find((item) => item.case.id === `effect-${definition.type}`);
      expect(entry, definition.type).toBeDefined();
      if (!entry) continue;
      const composition = entry.project.compositions[0];
      const effects = composition.layers[0].effects;
      expect(effects).toHaveLength(1);
      expect(effects[0].type).toBe(definition.type);
      expect(effects[0].enabled).toBe(true);
      expect(compileEffectProgram(composition, 0.5).count, definition.type).toBeGreaterThan(0);
      for (const parameter of definition.parameters) {
        const value = effects[0].parameters[parameter.key];
        expect(Number.isFinite(value), `${definition.type}.${parameter.key}`).toBe(true);
        if (parameter.min !== undefined) expect(value).toBeGreaterThanOrEqual(parameter.min);
        if (parameter.max !== undefined) expect(value).toBeLessThanOrEqual(parameter.max);
      }
    }
  });

  it("is deterministic and every generated project passes the real schema boundary", () => {
    const first = buildEffectCases();
    expect(buildEffectCases()).toEqual(first);
    for (const entry of first) {
      expect(() => validateProjectDocument(entry.project), entry.case.id).not.toThrow();
    }
  });

  it("activates neutral color, channel and geometry defaults", () => {
    const cases = buildEffectCases();
    for (const type of [
      "brightness-contrast",
      "exposure",
      "hue-saturation",
      "levels",
      "curves",
      "vibrance",
      "color-balance",
      "color-matrix",
      "channel-mixer",
      "transform",
      "offset",
      "crop",
      "white-balance",
      "set-channels",
      "asc-cdl",
      "rgb-lift-gamma-gain",
      "log-wheels",
      "hsl-secondary",
      "bezier-warp",
      "power-pin",
      "frequency-separation",
    ]) {
      const effect = cases.find((item) => item.case.id === `effect-${type}`)?.project
        .compositions[0].layers[0].effects[0];
      expect(effect?.parameters, type).not.toEqual(createEffect(type).parameters);
    }
  });

  it("provides alpha edges, dark and bright colors, fine detail and off-grid temporal samples", () => {
    const cases = buildEffectCases();
    const entry = cases.find((item) => item.case.id === "effect-echo");
    expect(entry).toBeDefined();
    if (!entry) return;
    const source = entry.project.compositions[1];
    expect(source.background[3]).toBe(0);
    expect(source.layers.some((layer) => layer.color[3] < 0.5)).toBe(true);
    expect(source.layers.some((layer) => layer.color[0] > 0.95)).toBe(true);
    expect(source.layers.some((layer) => layer.color[0] < 0.02)).toBe(true);
    expect(source.layers.some((layer) => layer.size[0] === 1)).toBe(true);
    expect(source.layers[0].transform.position[0].mode).toBe("animated");
    expect(entry.case.sequence).toBe(true);
    expect(entry.case.frames).toContain(1);
  });

  it("uses a nonlinear resource for both LUT interpolation modes and distinct filmic curves", () => {
    const cases = buildEffectCases();
    const tri = cases.find((item) => item.case.id === "effect-lut")?.project.compositions[0]
      .layers[0].effects[0];
    const tetra = cases.find((item) => item.case.id === "lut-tetrahedral")?.project.compositions[0]
      .layers[0].effects[0];
    expect(tri?.parameters.interpolation).toBe(0);
    expect(tetra?.parameters.interpolation).toBe(1);
    expect(tri?.resource).toEqual(tetra?.resource);
    expect(tri?.resource?.data).toHaveLength(81);
    expect(tri?.resource?.data[0]).toBeGreaterThan(0);
    const curves = ["effect-filmic-tone-map", "filmic-aces"].map(
      (id) =>
        cases.find((item) => item.case.id === id)?.project.compositions[0].layers[0].effects[0]
          .parameters.curve,
    );
    expect(curves).toEqual([1, 0]);
  });
});
