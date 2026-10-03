import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateTextAnimatorStack,
  segmentTextLayoutUnits,
} from "../../src/core/animation/text-animator-stack";
import { evaluateAnimatable } from "../../src/core/animation/timeline";
import { ShapeEvaluationCache } from "../../src/core/layers/shape-graph";
import { validateProjectDocument } from "../../src/core/project/validation/document";
import { flattenSceneLayers } from "../../src/core/scene/scene-evaluation";
import { buildSceneGeometry } from "../../src/renderer/geometry/geometry";
import { buildSceneCases } from "./generators/scenes";

describe("specialized parity scenes", () => {
  it("builds deterministic valid documents with visible evaluated surfaces at every requested frame", () => {
    const cases = buildSceneCases();
    expect(buildSceneCases()).toEqual(cases);
    expect(new Set(cases.map((item) => item.case.id)).size).toBe(cases.length);
    for (const { case: entry, project } of cases) {
      expect(() => validateProjectDocument(project), entry.id).not.toThrow();
      const composition = project.compositions[0];
      for (const frame of entry.frames) {
        const layers = flattenSceneLayers(composition, project, frame / 30);
        expect(
          layers.some((layer) => layer.transform.opacity > 0),
          entry.id,
        ).toBe(true);
        const geometry = buildSceneGeometry(composition, layers);
        if (!layers.some(({ layer }) => layer.kind === "generator")) {
          expect(geometry.data.length, entry.id).toBeGreaterThan(0);
          expect([...geometry.data].every(Number.isFinite), entry.id).toBe(true);
        }
      }
    }
  });

  it("retains a surface boundary around the nested adjustment and maps nested time", () => {
    const { project } = requireCase("scene-nested-adjustment");
    const root = project.compositions[0];
    const wrapper = flattenSceneLayers(root, project, 1).find(
      (layer) => layer.precompositionSurface,
    );
    expect(wrapper?.precompositionSurface?.time).toBeCloseTo(0.8);
    const middle = project.compositions.find(
      (item) => item.id === wrapper?.layer.sourceCompositionId,
    );
    expect(middle?.layers[0].kind).toBe("adjustment");
    expect(wrapper?.layer.effects.some((effect) => effect.enabled)).toBe(true);
    expect(middle?.layers[1].sourceCompositionId).toBe(project.compositions[2].id);
  });

  it("resolves stable path-mask references and exercises RGB, luminance and alpha mattes", () => {
    const { project } = requireCase("scene-path-mask-reference");
    const layer = project.compositions[0].layers[0];
    const result = new ShapeEvaluationCache().evaluate(layer, 0.5);
    expect(result.masks).toHaveLength(1);
    expect(result.masks[0].path.vertices).toHaveLength(4);
    expect(result.masks[0].pathId).toBe(layer.effects[0].mask?.pathId);
    const channels = buildSceneCases().flatMap(({ project }) =>
      project.compositions.flatMap((composition) =>
        composition.layers.flatMap((layer) =>
          layer.effects
            .filter((effect) => effect.type === "set-matte")
            .map((effect) => effect.parameters.channel),
        ),
      ),
    );
    expect(channels).toEqual([0, 3, 4]);
  });

  it("keeps multilingual graphemes and uses time-varying selectors rather than an inert text label", () => {
    const text = requireCase("scene-text-animators").project.compositions[0].layers[0];
    const units = segmentTextLayoutUnits(text.text ?? "");
    expect(units.some((unit) => unit.text === "e\u0301")).toBe(true);
    const groups = text.textAnimator?.groups ?? [];
    expect(
      new Set(groups.flatMap((group) => group.selectors.map((selector) => selector.kind))),
    ).toEqual(new Set(["range", "expression", "wiggly"]));
    expect(evaluateTextAnimatorStack(groups, units[0], { time: 0 })).not.toEqual(
      evaluateTextAnimatorStack(groups, units[0], { time: 1 }),
    );
  });

  it("animates blur targets and cloner transforms at arbitrary times", () => {
    const blur = requireCase("scene-motion-blur").project.compositions[0];
    expect(blur.motionBlur.enabled).toBe(true);
    expect(blur.layers.every((layer) => layer.motionBlur)).toBe(true);
    const { project } = requireCase("scene-cloners");
    const composition = project.compositions[0];
    expect(flattenSceneLayers(composition, project, 0)).toHaveLength(23);
    expect(flattenSceneLayers(composition, project, 0)).not.toEqual(
      flattenSceneLayers(composition, project, 1),
    );
    expect(evaluateAnimatable(blur.layers[0].transform.position[0], 0.73)).not.toBe(
      evaluateAnimatable(blur.layers[0].transform.position[0], 0),
    );
  });

  it("requires the existing audio-analysis plugin and a real immutable audio payload", () => {
    const cases = buildSceneCases().filter((item) =>
      item.case.features.includes("feature:audio-analysis"),
    );
    expect(cases).toHaveLength(3);
    for (const { case: entry, project } of cases) {
      expect(entry.plugins).toEqual(["examples/plugins/audio-spectrum"]);
      const source = project.sources.find((source) => source.kind === "audio");
      expect(source?.mimeType).toBe("audio/wav");
      expect(project.mediaImports?.entries.some((entry) => entry.sourceId === source?.id)).toBe(
        true,
      );
      expect(
        project.compositions[0].layers.some(
          (layer) => layer.kind === "audio" && layer.audioEnabled && layer.sourceId === source?.id,
        ),
      ).toBe(true);
    }
    const manifest = readFileSync("examples/plugins/audio-spectrum/plugin.toml", "utf8");
    expect(manifest).toContain('"audio_analysis"');
    expect(manifest).toContain('node_type = "audio_spectrum"');
  });
});

function requireCase(id: string) {
  const result = buildSceneCases().find((item) => item.case.id === id);
  if (!result) throw new Error(`Missing scene fixture ${id}`);
  return result;
}
