import { staticValue } from "../../src/core/types";
import { createEffect } from "../../src/effects/registry";
import { caseFor, fixture } from "../../tests/parity/generators/base";

/** Stable, portable throughput fixtures; private owner projects are never rewritten. */
export function performanceFixtures() {
  return [
    { id: "composite-1080p", width: 1920, height: 1080, effects: false },
    { id: "composite-4k", width: 3840, height: 2160, effects: false },
    { id: "effect-chain-1080p", width: 1920, height: 1080, effects: true },
  ].map(({ id, width, height, effects }) => {
    const { project, composition, layer } = fixture(id);
    composition.width = width;
    composition.height = height;
    composition.duration = 20;
    composition.workArea = { start: 0, end: 20 };
    composition.layers = Array.from({ length: effects ? 1 : 20 }, (_, index) => {
      const shape = layer("shape", `Shape ${index + 1}`);
      shape.color = [((index % 3) + 1) / 4, ((index % 5) + 1) / 6, ((index % 7) + 1) / 8, 0.7];
      if (effects) shape.color = [1, 0.85, 0.6, 0.95];
      shape.size = [width / 3, height / 3];
      shape.transform.anchor = [staticValue(width / 6), staticValue(height / 6), staticValue(0)];
      shape.transform.position[0] = staticValue(effects ? width / 2 : (width * (index % 5)) / 5);
      shape.transform.position[1] = staticValue(effects ? height / 2 : (height * (index % 4)) / 4);
      shape.transform.rotation[2] = {
        mode: "animated",
        keyframes: [
          { id: `${id}-${index}-start`, time: 0, value: index * 7, interpolation: "linear" },
          { id: `${id}-${index}-end`, time: 20, value: index * 7 + 360, interpolation: "linear" },
        ],
      };
      if (effects) {
        shape.effects = ["gaussian-blur", "glow", "curves", "chromatic", "exposure"].map(
          createEffect,
        );
        shape.effects[2].parameters.midtones = 0.12;
        shape.effects[4].parameters.exposure = 0.5;
      }
      return shape;
    });
    const generated = caseFor(
      id,
      project,
      effects ? ["benchmark:effect-chain"] : ["benchmark:composite"],
      {
        frames: Array.from({ length: 600 }, (_, frame) => frame),
      },
    );
    generated.case.project = `artifacts/performance/projects/${id}/project.json`;
    return generated;
  });
}
