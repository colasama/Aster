import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { flattenSceneLayers } from "../core/scene-evaluation";
import {
  createPrecompositionSurfaceBudget,
  MAX_PRECOMPOSITION_SURFACES,
  planPrecompositionSurface,
  precompositionSurfaceCacheKey,
} from "./precomposition-surface-plan";

function surfaceScene(width = 1_920, height = 1_080) {
  const project = createBlankProject();
  const root = project.compositions[0];
  const nested = structuredClone(root);
  nested.id = crypto.randomUUID();
  nested.width = width;
  nested.height = height;
  const wrapper = createLayerForComposition("precomposition", root);
  wrapper.sourceCompositionId = nested.id;
  wrapper.threeDimensional = true;
  root.layers = [wrapper];
  project.compositions.push(nested);
  return flattenSceneLayers(root, project, 1.25)[0];
}

describe("precomposition surface planning", () => {
  it("allocates bounded full-resolution surfaces and stable time-addressed keys", () => {
    const scene = surfaceScene();
    const budget = createPrecompositionSurfaceBudget();
    const plan = planPrecompositionSurface(
      { scene, deviceMaxTextureDimension: 8_192, hasEffects: false },
      budget,
    );
    expect(plan).toMatchObject({ status: "ready", width: 1_920, height: 1_080 });
    expect(budget).toMatchObject({ surfaces: 1, textures: 2, pixels: 1_920 * 1_080 });
    expect(precompositionSurfaceCacheKey(scene, 7, plan.width, plan.height)).toContain(
      `7:${scene.precompositionSurface?.composition.id}:1.250000000:1920x1080`,
    );
  });

  it("downscales proportionally under an explicit VRAM budget", () => {
    const scene = surfaceScene(4_096, 2_048);
    const plan = planPrecompositionSurface(
      {
        scene,
        deviceMaxTextureDimension: 8_192,
        memoryBudgetMb: 16,
        hasEffects: true,
      },
      createPrecompositionSurfaceBudget(),
    );
    expect(plan.status).toBe("ready");
    expect(plan.downgraded).toBe(true);
    expect(plan.width / plan.height).toBeCloseTo(2, 1);
    expect(plan.estimatedBytes).toBeLessThanOrEqual(16 * 0.35 * 1024 * 1024);
  });

  it("rejects cycles, depth overflow, and excess surface count", () => {
    const scene = surfaceScene();
    if (!scene.precompositionSurface) throw new Error("surface missing");
    scene.precompositionSurface.compositionPath.push(scene.precompositionSurface.composition.id);
    expect(
      planPrecompositionSurface(
        { scene, deviceMaxTextureDimension: 8_192, hasEffects: false },
        createPrecompositionSurfaceBudget(),
      ),
    ).toMatchObject({ status: "skipped", diagnostic: expect.stringContaining("cycle") });

    scene.precompositionSurface.compositionPath = [];
    const budget = createPrecompositionSurfaceBudget();
    budget.surfaces = MAX_PRECOMPOSITION_SURFACES;
    expect(
      planPrecompositionSurface(
        { scene, deviceMaxTextureDimension: 8_192, hasEffects: false },
        budget,
      ),
    ).toMatchObject({ status: "skipped", diagnostic: expect.stringContaining("surface count") });
  });
});
