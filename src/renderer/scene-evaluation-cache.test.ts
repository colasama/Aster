import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../core/project";
import { SceneEvaluationCache } from "./scene-evaluation-cache";

describe("SceneEvaluationCache", () => {
  it("reuses an identical composition evaluation", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const cache = new SceneEvaluationCache();

    const first = cache.evaluate(composition, project, 1.25, 1920, 1080);
    const second = cache.evaluate(composition, project, 1.25, 1920, 1080);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.sceneLayers).toBe(first.sceneLayers);
    expect(second.geometry).toBe(first.geometry);
    expect(cache.hitRate()).toBe(0.5);
  });

  it("separates time and resolution dependent evaluations", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const cache = new SceneEvaluationCache();

    expect(cache.evaluate(composition, project, 0, 1920, 1080).cacheHit).toBe(false);
    expect(cache.evaluate(composition, project, 1, 1920, 1080).cacheHit).toBe(false);
    expect(cache.evaluate(composition, project, 1, 3840, 2160).cacheHit).toBe(false);
    expect(cache.evaluate(composition, project, 1, 1920, 1080).cacheHit).toBe(true);
  });

  it("invalidates cached geometry when the project revision changes", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const cache = new SceneEvaluationCache();

    cache.evaluate(composition, project, 0, 1920, 1080);
    expect(cache.evaluate(composition, project, 0, 1920, 1080).cacheHit).toBe(true);

    const revisedProject = { ...project, name: `${project.name} revised` };
    expect(cache.evaluate(composition, revisedProject, 0, 1920, 1080).cacheHit).toBe(false);
  });
});
