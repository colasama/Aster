import { describe, expect, it } from "vitest";
import { createParticleLayerForComposition } from "./bundled-particle";
import { createGeneratorLayerForComposition, createLayerForComposition } from "./layer-factory";
import { createBlankComposition } from "./project";

describe("scene-generator layer construction", () => {
  it("keeps generic construction plugin-explicit and blend-neutral", () => {
    const composition = createBlankComposition();
    const generator = {
      pluginId: "org.example.generator",
      nodeType: "points",
      apiVersion: 1,
      parameters: { count: 256 },
    };
    const layer = createGeneratorLayerForComposition(composition, generator, 2, "Points");

    expect(layer).toMatchObject({
      kind: "generator",
      name: "Points",
      inPoint: 2,
      blendMode: "normal",
      generator,
    });
  });

  it("keeps the bundled particle defaults inside the bundled adapter", () => {
    const layer = createParticleLayerForComposition(createBlankComposition());
    expect(layer).toMatchObject({
      kind: "generator",
      name: "Particles",
      blendMode: "add",
      generator: {
        pluginId: "org.aster.builtin.particles",
        nodeType: "particle_system",
        apiVersion: 1,
      },
    });
  });
});

describe("null and solid layer construction", () => {
  it.each(["shape", "text"] as const)("centers a new %s layer anchor in source space", (kind) => {
    const layer = createLayerForComposition(kind, createBlankComposition());
    expect(
      layer.transform.anchor.map((axis) => (axis.mode === "static" ? axis.value : NaN)),
    ).toEqual([layer.size[0] * 0.5, layer.size[1] * 0.5, 0]);
  });

  it("creates a selectable transform-only null without a render source", () => {
    const composition = createBlankComposition();
    const layer = createLayerForComposition("null", composition, 1.5);
    expect(layer).toMatchObject({
      kind: "null",
      name: "Null Object",
      visible: true,
      inPoint: 1.5,
      threeDimensional: false,
      solid: undefined,
    });
    expect(
      layer.transform.position.map((axis) => (axis.mode === "static" ? axis.value : NaN)),
    ).toEqual([composition.width / 2, composition.height / 2, 0]);
  });

  it("creates a composition-sized solid with a dedicated bounded source", () => {
    const composition = createBlankComposition();
    const layer = createLayerForComposition("solid", composition);
    expect(layer.solid).toEqual({
      width: composition.width,
      height: composition.height,
      color: [0.3, 0.55, 1, 1],
    });
    expect(layer.size).toEqual([composition.width, composition.height]);
    expect(layer.color).toEqual(layer.solid?.color);
  });
});
