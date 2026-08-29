import { getProperty, type PropertyPath } from "./operations";
import { activeComposition } from "./project";
import { flattenSceneLayers } from "./scene-evaluation";
import { evaluateAnimatable, evaluateEffectParameter } from "./timeline";
import type { Composition, Id, Layer, Project } from "./types";

const MAX_CONTEXT_LAYERS = 128;
const MAX_SELECTED_LAYERS = 16;
const MAX_EFFECTS_PER_LAYER = 32;
const MAX_PARAMETERS_PER_EFFECT = 32;
const MAX_KEYFRAME_TIMES = 64;
export const MAX_AI_CONTEXT_BYTES = 96 * 1024;

const propertyPaths: PropertyPath[] = [
  "position.0",
  "position.1",
  "position.2",
  "rotation.0",
  "rotation.1",
  "rotation.2",
  "scale.0",
  "scale.1",
  "scale.2",
  "opacity",
];

export interface AiProjectContext {
  schemaVersion: 1;
  project: { id: Id; name: string; compositionCount: number };
  composition: {
    id: Id;
    name: string;
    width: number;
    height: number;
    duration: number;
    frameRate: number;
  };
  currentTime: number;
  selectedLayerIds: Id[];
  properties: ReturnType<typeof queryProperties>;
  timeline: ReturnType<typeof queryTimeline>;
  scene: ReturnType<typeof queryScene>;
  assets: ReturnType<typeof queryAssets>;
}

export function buildAiContext(
  project: Project,
  selectedLayerIds: Id[],
  currentTime: number,
): AiProjectContext {
  const composition = activeComposition(project);
  const context: AiProjectContext = {
    schemaVersion: 1,
    project: {
      id: project.id,
      name: boundedText(project.name),
      compositionCount: project.compositions.length,
    },
    composition: {
      id: composition.id,
      name: boundedText(composition.name),
      width: composition.width,
      height: composition.height,
      duration: composition.duration,
      frameRate: composition.frameRate.numerator / composition.frameRate.denominator,
    },
    currentTime: finite(currentTime),
    selectedLayerIds: selectedLayerIds.slice(0, MAX_SELECTED_LAYERS),
    properties: queryProperties(composition, selectedLayerIds, currentTime),
    timeline: queryTimeline(composition),
    scene: queryScene(project, composition, currentTime),
    assets: queryAssets(project),
  };
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > MAX_AI_CONTEXT_BYTES)
    throw new Error("Bounded AI project context exceeded its size budget");
  return context;
}

export function queryProperties(composition: Composition, selectedLayerIds: Id[], time: number) {
  const selected = new Set(selectedLayerIds.slice(0, MAX_SELECTED_LAYERS));
  return composition.layers
    .filter((layer) => selected.has(layer.id))
    .map((layer) => ({
      id: layer.id,
      name: boundedText(layer.name),
      kind: layer.kind,
      properties: Object.fromEntries(
        propertyPaths.map((path) => {
          const property = getProperty(layer, path);
          return [
            path,
            {
              value: finite(evaluateAnimatable(property, time)),
              animated: property.mode === "animated",
              keyframeTimes:
                property.mode === "animated"
                  ? property.keyframes.slice(0, MAX_KEYFRAME_TIMES).map((keyframe) => keyframe.time)
                  : [],
            },
          ];
        }),
      ),
      effects: layer.effects.slice(0, MAX_EFFECTS_PER_LAYER).map((effect) => ({
        id: effect.id,
        type: effect.type,
        enabled: effect.enabled,
        parameters: Object.fromEntries(
          Object.keys(effect.parameters)
            .slice(0, MAX_PARAMETERS_PER_EFFECT)
            .map((parameter) => [
              parameter,
              finite(
                evaluateEffectParameter(effect, parameter, time, effect.parameters[parameter]),
              ),
            ]),
        ),
      })),
    }));
}

export function queryTimeline(composition: Composition) {
  return composition.layers.slice(0, MAX_CONTEXT_LAYERS).map((layer) => ({
    id: layer.id,
    name: boundedText(layer.name),
    kind: layer.kind,
    inPoint: finite(layer.inPoint),
    outPoint: finite(layer.outPoint),
    sourceOffset: finite(layer.timeOffset ?? 0),
    sourceStretch: finite(layer.timeStretch ?? 1),
    keyframeCount: countLayerKeyframes(layer),
    effectTypes: layer.effects.slice(0, MAX_EFFECTS_PER_LAYER).map((effect) => effect.type),
  }));
}

export function queryScene(project: Project, composition: Composition, time: number) {
  return flattenSceneLayers(composition, project, time)
    .slice(0, MAX_CONTEXT_LAYERS)
    .map((scene) => {
      const transform = scene.transform;
      return {
        instanceId: scene.instanceId,
        layerId: scene.layer.id,
        name: boundedText(scene.layer.name),
        kind: scene.layer.kind,
        position: transform.position.map(finite),
        rotation: transform.rotation.map(finite),
        scale: transform.scale.map(finite),
        opacity: finite(transform.opacity),
        threeDimensional: scene.layer.threeDimensional,
      };
    });
}

export function queryAssets(project: Project) {
  return project.sources.slice(0, MAX_CONTEXT_LAYERS).map((source) => ({
    name: boundedText(source.name),
    mimeType: boundedText(source.mimeType),
    width: "width" in source ? source.width : undefined,
    height: "height" in source ? source.height : undefined,
    duration: "duration" in source ? source.duration : undefined,
  }));
}

function countLayerKeyframes(layer: Layer): number {
  const transform = [
    ...layer.transform.position,
    ...layer.transform.rotation,
    ...layer.transform.scale,
    ...layer.transform.anchor,
    layer.transform.opacity,
  ];
  const transformCount = transform.reduce(
    (total, property) => total + (property.mode === "animated" ? property.keyframes.length : 0),
    0,
  );
  const effectCount = layer.effects.reduce(
    (total, effect) =>
      total +
      Object.values(effect.parameterKeyframes ?? {}).reduce(
        (subtotal, keyframes) => subtotal + keyframes.length,
        0,
      ),
    0,
  );
  return transformCount + effectCount;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function boundedText(value: string): string {
  return value.slice(0, 256);
}
