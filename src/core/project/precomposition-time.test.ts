import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../animation/expressions";
import { evaluateLayerSourceTime } from "../animation/layer-time";
import { evaluateShapePath } from "../animation/path-morph";
import { createDefaultWigglySelector } from "../animation/text-animator-groups";
import {
  evaluateTextAnimatorStack,
  segmentTextLayoutUnits,
} from "../animation/text-animator-stack";
import { evaluateEffectParameter } from "../animation/timeline";
import { createLayerForComposition } from "../layers/layer-factory";
import { flattenShapeGraph } from "../layers/shape-graph";
import { createParticleLayerForComposition } from "../scene/bundled-particle";
import { evaluateCameraSettings } from "../scene/camera-settings";
import { type FlattenedSceneLayer, flattenSceneLayers } from "../scene/scene-evaluation";
import { type Animatable, type BezierPath, staticValue } from "../types";
import { precomposeLayers } from "./precomposition";
import { createBlankProject } from "./project";
import { serializeProject, validateProjectDocument } from "./project-file";

const track = (start: number, end: number): Animatable => ({
  mode: "animated",
  keyframes: [
    { id: "lead", time: 1, value: start - 5, interpolation: "linear" },
    {
      id: "start",
      time: 2,
      value: start,
      interpolation: "bezier",
      easing: [0.2, 0.05, 0.7, 1],
      spatialOut: 4,
    },
    { id: "end", time: 6, value: end, interpolation: "linear", spatialIn: -2 },
  ],
});

function animatedProject() {
  const project = createBlankProject();
  const composition = project.compositions[0];
  const parent = createLayerForComposition("null", composition, 3);
  parent.transform.position[0] = track(200, 650);
  parent.expressions = { "position.1": "540 + 20 * sin(time * 2)" };
  const shape = createLayerForComposition("shape", composition, 3);
  shape.parentId = parent.id;
  shape.transform.position[0] = track(50, 150);
  shape.transform.position[1] = staticValue(0);
  shape.expressions = { "shape.morphProgress": "value + 8 * sin(time)" };
  const path: BezierPath = {
    closed: true,
    vertices: [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0, 0.5],
    ].map(([x, y]) => ({
      position: [x, y],
      inTangent: [0, 0],
      outTangent: [0, 0],
    })),
  };
  if (!shape.shape) throw new Error("Shape defaults missing");
  shape.shape.kind = "bezier";
  shape.shape.path = path;
  shape.shape.morph = {
    target: {
      ...path,
      vertices: path.vertices.map((vertex) => ({ ...vertex, position: [vertex.position[0], 0] })),
    },
    progress: track(10, 90),
  };
  const radius = track(10, 40);
  if (radius.mode !== "animated") throw new Error("Animated fixture expected");
  shape.effects = [
    {
      id: "blur",
      type: "gaussian-blur",
      name: "Blur",
      enabled: true,
      parameters: { radius: 10 },
      parameterKeyframes: { radius: radius.keyframes },
    },
  ];
  shape.shapeGraph = {
    id: "graph",
    revision: 1,
    paths: [{ id: "path", revision: 1, path }],
    rootGroupIds: ["group"],
    groups: [
      {
        id: "group",
        name: "Animated group",
        visible: true,
        transform: {
          position: [track(0, 120), staticValue(0)],
          scale: [staticValue(100), staticValue(100)],
          rotation: track(0, 80),
          opacity: staticValue(100),
        },
        children: [{ kind: "path", id: "instance", pathId: "path", visible: true }],
      },
    ],
  };
  const text = createLayerForComposition("text", composition, 4);
  text.text = "日本語";
  const animator = text.textAnimator?.groups[0];
  if (!animator) throw new Error("Text defaults missing");
  animator.properties.position = [track(5, 120), staticValue(0), staticValue(0)];
  const wiggly = createDefaultWigglySelector();
  wiggly.wigglesPerSecond = track(6, 15);
  animator.selectors = [wiggly];
  const camera = createLayerForComposition("camera", composition, 3);
  if (!camera.camera) throw new Error("Camera defaults missing");
  camera.camera.zoom = track(800, 1400);
  camera.camera.orientation[1] = track(0, 15);
  const footage = createLayerForComposition("image", composition, 3);
  footage.timeOffset = 2;
  footage.timeStretch = 1.5;
  footage.timeRemap = track(2, 9);
  composition.layers = [text, shape, parent, camera, footage];
  for (const layer of composition.layers) layer.outPoint = 7;
  return project;
}

function appearance(scene: FlattenedSceneLayer) {
  const { layer, localTime: time, sourceComposition: composition } = scene;
  return {
    id: layer.id,
    transform: scene.transform,
    effect: layer.effects.map((effect) => evaluateEffectParameter(effect, "radius", time)),
    path:
      layer.shape &&
      evaluateShapePath(layer.shape, time, layer.expressions?.["shape.morphProgress"]),
    graph: layer.shapeGraph && flattenShapeGraph(layer.shapeGraph, time),
    camera:
      layer.camera &&
      evaluateCameraSettings(layer.camera, scene.transform, time, composition.width),
    text:
      layer.textAnimator &&
      segmentTextLayoutUnits(layer.text ?? "").map((unit) =>
        evaluateTextAnimatorStack(layer.textAnimator?.groups ?? [], unit, {
          time,
          evaluateExpression: (expression, context) =>
            evaluateExpression(expression, { time: context.time, value: context.selectorValue }),
        }),
      ),
    sourceTime: evaluateLayerSourceTime(layer, time),
  };
}

describe("precomposition time preservation", () => {
  it("keeps every frame and pre-roll key intact through nesting and persistence", () => {
    const original = animatedProject();
    const source = original.compositions[0];
    const snapshot = structuredClone(original);
    const first = precomposeLayers(
      original,
      source.layers.map((layer) => layer.id),
    );
    if (!first) throw new Error("Precomposition missing");
    const nested = first.project.compositions.find((c) => c.id === first.nestedCompositionId);
    const wrapper = first.project.compositions[0].layers[0];
    expect(nested).toMatchObject({ duration: 7, workArea: { start: 3, end: 7 } });
    expect(wrapper).toMatchObject({ inPoint: 3, outPoint: 7, timeOffset: 3 });
    expect(first.project.compositions[0].duration).toBe(source.duration);
    expect(nested?.layers).toEqual(source.layers);
    expect(original).toEqual(snapshot);

    const second = precomposeLayers(first.project, [first.wrapperId]);
    if (!second) throw new Error("Second precomposition missing");
    const reopened = validateProjectDocument(JSON.parse(serializeProject(second.project)));
    for (let frame = 0; frame <= 240; frame++) {
      const time = frame / 30;
      const before = flattenSceneLayers(source, original, time)
        .map(appearance)
        .map((sample) => ({
          ...sample,
          transform: {
            ...sample.transform,
            // Identity wrapper composition can round the final position by one ULP.
            position: sample.transform.position.map((value) => expect.closeTo(value, 9)),
          },
        }));
      const after = flattenSceneLayers(reopened.compositions[0], reopened, time).map(appearance);
      expect(after, `frame ${frame}`).toEqual(before);
    }
  });

  it.each(["adjustment", "generator"] as const)(
    "preserves the source clock of isolated %s surfaces",
    (kind) => {
      const project = createBlankProject();
      const source = project.compositions[0];
      const layer =
        kind === "generator"
          ? createParticleLayerForComposition(source)
          : createLayerForComposition("adjustment", source, 5);
      layer.inPoint = 5;
      layer.outPoint = 8;
      source.layers = [layer];
      const result = precomposeLayers(project, [layer.id]);
      if (!result) throw new Error("Precomposition missing");
      for (let frame = 150; frame < 240; frame++) {
        const time = frame / 30;
        const [surface] = flattenSceneLayers(result.project.compositions[0], result.project, time);
        expect(surface.precompositionSurface?.time).toBe(time);
        expect(surface.precompositionSurface?.composition.layers[0]).toEqual(layer);
      }
    },
  );
});
