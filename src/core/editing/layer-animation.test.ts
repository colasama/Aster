import { describe, expect, it } from "vitest";
import { normalizeAiCommands } from "../../ai/command-normalizer";
import { createDefaultBezierPath } from "../../renderer/geometry/vector-path";
import { createInitialState, editorReducer } from "../../state/editor-store";
import { evaluateLayerSourceTime } from "../animation/layer-time";
import {
  createDefaultExpressionSelector,
  createDefaultTextAnimatorGroup,
  createDefaultWigglySelector,
} from "../animation/text-animator-groups";
import { evaluateAnimatable } from "../animation/timeline";
import { createLayerForComposition } from "../layers/layer-factory";
import { createBlankComposition, createBlankProject } from "../project/project";
import { serializeProject, validateProjectDocument } from "../project/project-file";
import type { Animatable, Keyframe } from "../types";
import { collectLayerAnimationKeyframes } from "./layer-animation";
import { collectLayerPropertyPaths, getProperty, setProperty } from "./layer-properties";
import { applyOperations } from "./operations";

function track(id: string, value = 20): Animatable {
  return {
    mode: "animated",
    keyframes: [1, 3].map((time, index) => ({
      id: `${id}-${index}`,
      time,
      value: value + index,
      interpolation: "bezier",
      easing: [0.2, 0.1, 0.8, 0.9],
      spatialIn: -0.1,
      spatialOut: 0.2,
    })),
  };
}

function fixture() {
  const project = createBlankProject();
  const composition = project.compositions[0];
  const layer = createLayerForComposition("solid", composition);
  layer.inPoint = 2;
  layer.outPoint = 6;
  layer.transform.opacity = track("opacity");
  composition.layers = [layer];
  return { project, composition, layer };
}

describe("layer animation moves", () => {
  it("moves all numeric tracks, disabled effects and time remapping without changing curve data", () => {
    const { project, composition } = fixture();
    const layers = ["camera", "text", "shape"].map((kind) => {
      const layer = createLayerForComposition(kind as "camera" | "text" | "shape", composition);
      layer.inPoint = 2;
      layer.outPoint = 6;
      if (layer.textAnimator) {
        const group = createDefaultTextAnimatorGroup();
        group.selectors.push(createDefaultWigglySelector(), createDefaultExpressionSelector());
        layer.textAnimator.groups = [group];
      }
      if (layer.shape) {
        const path = createDefaultBezierPath();
        layer.shape = {
          ...layer.shape,
          kind: "bezier",
          path,
          morph: { target: structuredClone(path), progress: track("morph", 0) },
        };
      }
      for (const path of collectLayerPropertyPaths(layer)) {
        const property = getProperty(layer, path);
        setProperty(layer, path, track(`${layer.id}-${path}`, evaluateAnimatable(property, 0)));
      }
      layer.timeRemap = track(`${layer.id}-remap`, 0);
      layer.timeOffset = 0.5;
      layer.timeStretch = 2;
      layer.effects = [
        {
          id: "effect",
          type: "blur",
          name: "Blur",
          enabled: false,
          parameters: { radius: 0 },
          parameterKeyframes: {
            radius: (track(`${layer.id}-effect`) as { keyframes: Keyframe[] }).keyframes,
          },
        },
      ];
      return layer;
    });
    composition.layers = layers;
    const moved = applyOperations(
      project,
      layers.map(({ id }) => ({ type: "moveLayer", layerId: id, delta: 2 })),
    );
    for (const [index, layer] of moved.compositions[0].layers.entries()) {
      const original = layers[index];
      expect(layer).toMatchObject({ inPoint: 4, outPoint: 8, timeOffset: 0.5, timeStretch: 2 });
      expect(collectLayerAnimationKeyframes(layer)).toEqual(
        collectLayerAnimationKeyframes(original).map((key) => ({ ...key, time: key.time + 2 })),
      );
      for (const path of collectLayerPropertyPaths(original)) {
        for (const time of [1, 1.5, 2.5, 3])
          expect(evaluateAnimatable(getProperty(layer, path), time + 2)).toBeCloseTo(
            evaluateAnimatable(getProperty(original, path), time),
          );
      }
      expect(evaluateLayerSourceTime(layer, 4.5)).toBeCloseTo(
        evaluateLayerSourceTime(original, 2.5),
      );
      expect(layer.effects[0].parameterKeyframes?.radius.map((key) => key.time)).toEqual([3, 5]);
    }
  });

  it("preserves trimmed and post-composition keys, source playback and child compositions", () => {
    const { project, layer } = fixture();
    const nested = createBlankComposition("Nested");
    project.compositions.push(nested);
    layer.kind = "precomposition";
    layer.sourceCompositionId = nested.id;
    layer.transform.opacity = {
      mode: "animated",
      keyframes: [0.5, 15].map((time) => ({
        id: String(time),
        time,
        value: 30,
        interpolation: "linear",
      })),
    };
    layer.timeOffset = 4;
    layer.timeStretch = 2;
    const moved = applyOperations(project, [{ type: "moveLayer", layerId: layer.id, delta: 1 }]);
    const next = moved.compositions[0].layers[0];
    expect(collectLayerAnimationKeyframes(next).map((key) => key.time)).toEqual([1.5, 16]);
    expect(evaluateLayerSourceTime(next, 4)).toBe(evaluateLayerSourceTime(layer, 3));
    expect(collectLayerAnimationKeyframes(layer).map((key) => key.time)).toEqual([0.5, 15]);
    expect(moved.compositions[1]).toEqual(nested);
  });

  it("leaves keys fixed when trimming, and rejects invalid or locked moves atomically", () => {
    const { project, layer } = fixture();
    const trimmed = applyOperations(project, [
      { type: "setLayerTiming", layerId: layer.id, inPoint: 3, outPoint: 5 },
    ]);
    expect(collectLayerAnimationKeyframes(trimmed.compositions[0].layers[0])).toEqual(
      collectLayerAnimationKeyframes(layer),
    );
    const snapshot = structuredClone(project);
    for (const delta of [-2, 100, NaN, Infinity])
      expect(() =>
        applyOperations(project, [{ type: "moveLayer", layerId: layer.id, delta }]),
      ).toThrow("bounds");
    expect(project).toEqual(snapshot);
    layer.locked = true;
    expect(() =>
      applyOperations(project, [{ type: "moveLayer", layerId: layer.id, delta: 1 }]),
    ).toThrow("locked");
  });

  it("normalizes a move command and saves, undoes and redoes a group as one transaction", () => {
    const { project, composition, layer } = fixture();
    const second = structuredClone(layer);
    second.id = "second";
    composition.layers.push(second);
    const commands = composition.layers.map(({ id }) => ({
      type: "moveLayer" as const,
      layerId: id,
      delta: 1,
    }));
    const normalized = normalizeAiCommands(commands, project, 0);
    expect(normalized.operations).toEqual(commands);
    const initial = editorReducer(createInitialState(), { type: "loadProject", project });
    const moved = editorReducer(initial, { type: "operation", operations: commands });
    expect(moved.history.past).toHaveLength(1);
    const restored = validateProjectDocument(JSON.parse(serializeProject(moved.project)));
    expect(restored.compositions[0].layers).toEqual(moved.project.compositions[0].layers);
    const undone = editorReducer(moved, { type: "undo" });
    expect(undone.project.compositions).toEqual(project.compositions);
    expect(editorReducer(undone, { type: "redo" }).project.compositions).toEqual(
      moved.project.compositions,
    );
  });
});
