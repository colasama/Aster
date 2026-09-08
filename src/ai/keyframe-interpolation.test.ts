import { expect, it } from "vitest";
import { evaluateAnimatable } from "../core/animation/timeline";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import { normalizeAiCommands } from "./command-normalizer";

it("authors seekable linear, held, and custom eased motion while preserving legacy defaults", () => {
  const project = createBlankProject();
  const layer = createLayerForComposition("shape", project.compositions[0]);
  project.compositions[0].layers.push(layer);
  const motion = (options: Record<string, unknown>) => {
    const result = normalizeAiCommands(
      [0, 1].map((time) => ({
        type: "addKeyframe",
        layerId: layer.id,
        path: "position.0",
        time,
        value: time * 100,
        ...options,
      })),
      project,
      0,
    );
    const edited = result.project.compositions[0].layers.find((entry) => entry.id === layer.id);
    if (!edited) throw new Error("Expected authored layer");
    return edited.transform.position[0];
  };
  const linear = motion({ interpolation: "linear" });
  const held = motion({ interpolation: "step" });
  expect([0.75, 0.25, 0.5].map((time) => evaluateAnimatable(linear, time))).toEqual([75, 25, 50]);
  expect(evaluateAnimatable(held, 0.999)).toBe(0);
  expect(evaluateAnimatable(held, 1)).toBe(100);
  expect(
    evaluateAnimatable(motion({ interpolation: "bezier", easing: [0, 0, 1, 1] }), 0.5),
  ).toBeCloseTo(50);
  expect(evaluateAnimatable(motion({}), 0.5)).toBeGreaterThan(90);
  for (const invalid of [{ interpolation: "spline" }, { easing: [0, 1] }, { easing: [0, 1, 2, 1] }])
    expect(() => motion(invalid)).toThrow();
  expect(layer.transform.position[0].mode).toBe("static");
});
