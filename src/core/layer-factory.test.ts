import { describe, expect, it } from "vitest";
import { createParticleLayerForComposition } from "./bundled-particle";
import { createGeneratorLayerForComposition } from "./layer-factory";
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
