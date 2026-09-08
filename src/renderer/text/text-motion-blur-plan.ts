import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import {
  adaptiveMotionBlurSampleCount,
  compositionMotionBlurSettings,
  motionBlurInterval,
} from "../../core/animation/motion-blur";
import {
  clampTextAnimationTime,
  countAnimatedTextCharacters,
} from "../../core/animation/text-animator";
import {
  type EvaluatedTextAnimatorCharacter,
  evaluateTextAnimatorStack,
  segmentTextLayoutUnits,
} from "../../core/animation/text-animator-stack";
import { safeEvaluateTextSelectorExpression } from "../../core/animation/text-selector-expression";
import { type FlattenedSceneLayer, flattenSceneLayers } from "../../core/scene/scene-evaluation";
import type { Composition, Layer, Project } from "../../core/types";
import { textRasterResolutionScale } from "./text-rasterizer";

/** One microsecond keeps sub-frame samples distinct while producing stable bounded cache keys. */
export const TEXT_MOTION_BLUR_TIME_BUCKETS_PER_SECOND = 1_000_000;

export interface TextMotionBlurSample {
  /** Exact layer-source time used by the text animator evaluator. */
  localTime: number;
  /** Fraction of the canonical shutter exposure represented by this unique sample. */
  weight: number;
  /** Deterministic microsecond identity used only for cache/generation keys. */
  timeBucket: number;
}

export interface TextMotionBlurPlan {
  frameTime: number;
  sampleCount: number;
  samples: readonly TextMotionBlurSample[];
  transparentWeight: number;
}

export interface TextMotionBlurFramePlan {
  sampleCount: number;
  plans: ReadonlyMap<string, TextMotionBlurPlan>;
  /** Representative shutter scenes needed when the current-time scene does not contain a layer. */
  exposureSceneLayers: readonly FlattenedSceneLayer[];
  /** Current scenes plus exposure-only text scenes, kept in composition render order. */
  renderSceneLayers: readonly FlattenedSceneLayer[];
}

interface PlanTextMotionBlurFrameOptions {
  composition: Composition;
  project?: Project;
  frameTime: number;
  sceneLayers: readonly FlattenedSceneLayer[];
  resolutionScale?: number;
  evaluateSceneLayers?: (time: number) => readonly FlattenedSceneLayer[];
}

/**
 * Plans exact texture-local text samples. World/layer transform motion stays in the canonical
 * geometry-vector path; this plan only covers time-varying glyph pixels inside the layer quad.
 */
export function planTextMotionBlurFrame(
  options: PlanTextMotionBlurFrameOptions,
): TextMotionBlurFramePlan {
  const settings = compositionMotionBlurSettings(options.composition);
  const frameRate =
    options.composition.frameRate.numerator / options.composition.frameRate.denominator;
  if (!settings.enabled || settings.shutterAngle <= 0)
    return {
      sampleCount: 0,
      plans: new Map(),
      exposureSceneLayers: [],
      renderSceneLayers: options.sceneLayers,
    };
  if (!compositionMayContainMotionBlurText(options.composition, options.project))
    return {
      sampleCount: 0,
      plans: new Map(),
      exposureSceneLayers: [],
      renderSceneLayers: options.sceneLayers,
    };
  const evaluateSceneLayers =
    options.evaluateSceneLayers ??
    ((sampleTime: number) => flattenSceneLayers(options.composition, options.project, sampleTime));

  const baseInterval = motionBlurInterval(options.frameTime, frameRate, settings);
  const baseSampleSceneLayers = baseInterval.sampleTimes.map((sampleTime) =>
    evaluateSceneLayers(sampleTime),
  );
  const probeSceneLayers = [
    evaluateSceneLayers(baseInterval.openTime),
    ...baseSampleSceneLayers,
    evaluateSceneLayers(baseInterval.closeTime),
  ];
  const candidates = animatedTextSceneUnion([options.sceneLayers, ...probeSceneLayers]);
  if (candidates.size === 0)
    return {
      sampleCount: 0,
      plans: new Map(),
      exposureSceneLayers: [],
      renderSceneLayers: options.sceneLayers,
    };
  const probeScenes = probeSceneLayers.map(sceneByResourceId);
  let maximumTravel = 0;
  for (const [resourceInstanceId, scene] of candidates) {
    const probeTimes = probeScenes
      .map((scenes) => textAnimationTime(scenes.get(resourceInstanceId)))
      .filter((time): time is number => time !== undefined);
    if (probeTimes.length < 2) continue;
    let totalTravel = 0;
    for (let index = 1; index < probeTimes.length; index += 1)
      totalTravel += estimateTextAnimatorPixelTravel(
        scene.layer,
        probeTimes[index - 1],
        probeTimes[index],
        options.resolutionScale ?? 1,
      );
    maximumTravel = Math.max(maximumTravel, totalTravel);
  }
  const sampleCount = adaptiveMotionBlurSampleCount(settings, maximumTravel);
  const interval = motionBlurInterval(options.frameTime, frameRate, settings, sampleCount);
  const sampleSceneLayers =
    sampleCount === baseInterval.sampleTimes.length
      ? baseSampleSceneLayers
      : interval.sampleTimes.map((sampleTime) => evaluateSceneLayers(sampleTime));
  const sampleScenes = sampleSceneLayers.map(sceneByResourceId);
  const finalCandidates = animatedTextSceneUnion([options.sceneLayers, ...sampleSceneLayers]);
  const plans = new Map<string, TextMotionBlurPlan>();
  for (const resourceInstanceId of finalCandidates.keys()) {
    const weighted = new Map<number, { localTime: number; count: number }>();
    let transparentCount = 0;
    for (const scenes of sampleScenes) {
      const sampleScene = scenes.get(resourceInstanceId);
      const localTime = textAnimationTime(sampleScene);
      if (localTime === undefined) {
        transparentCount += 1;
        continue;
      }
      const timeBucket = textMotionBlurTimeBucket(localTime);
      const existing = weighted.get(timeBucket);
      if (existing) existing.count += 1;
      else weighted.set(timeBucket, { localTime, count: 1 });
    }
    const samples = [...weighted.entries()].map(([timeBucket, sample]) => ({
      localTime: sample.localTime,
      timeBucket,
      weight: sample.count / sampleCount,
    }));
    const transparentWeight = transparentCount / sampleCount;
    // A single full-weight state is identical to the ordinary text cache and must stay on its
    // zero-extra-submit fast path.
    if (samples.length <= 1 && transparentWeight === 0) continue;
    plans.set(resourceInstanceId, {
      frameTime: options.frameTime,
      sampleCount,
      samples,
      transparentWeight,
    });
  }
  const currentResourceIds = new Set(options.sceneLayers.map((scene) => scene.resourceInstanceId));
  const representatives = new Map<
    string,
    { scene: FlattenedSceneLayer; distance: number; order: number }
  >();
  for (let sampleIndex = 0; sampleIndex < sampleSceneLayers.length; sampleIndex += 1) {
    const distance = Math.abs(interval.sampleTimes[sampleIndex] - options.frameTime);
    for (let order = 0; order < sampleSceneLayers[sampleIndex].length; order += 1) {
      const scene = sampleSceneLayers[sampleIndex][order];
      if (!plans.has(scene.resourceInstanceId) || currentResourceIds.has(scene.resourceInstanceId))
        continue;
      const existing = representatives.get(scene.resourceInstanceId);
      if (!existing || distance < existing.distance)
        representatives.set(scene.resourceInstanceId, { scene, distance, order });
    }
  }
  const compositionOrder = new Map(
    options.composition.layers.map((layer, index) => [layer.id, index] as const),
  );
  const exposureSceneLayers = [...representatives.values()]
    .sort((left, right) => compareSceneOrder(left, right, compositionOrder))
    .map(({ scene }) => scene);
  const renderSceneLayers = [
    ...options.sceneLayers.map((scene, order) => ({ scene, distance: 0, order })),
    ...representatives.values(),
  ]
    .sort((left, right) => compareSceneOrder(left, right, compositionOrder))
    .map(({ scene }) => scene);
  return { sampleCount, plans, exposureSceneLayers, renderSceneLayers };
}

export function textMotionBlurTimeBucket(time: number): number {
  const finite = Number.isFinite(time) ? time : 0;
  return Math.round(finite * TEXT_MOTION_BLUR_TIME_BUCKETS_PER_SECOND);
}

/**
 * Conservative texture-pixel displacement bound for adaptive temporal sampling. It covers every
 * geometry-affecting text animator property without requiring a prior raster/readback.
 */
export function estimateTextAnimatorPixelTravel(
  layer: Layer,
  openTime: number,
  closeTime: number,
  resolutionScale = 1,
): number {
  if (layer.kind !== "text" || !layer.textAnimator?.enabled) return 0;
  const units = segmentTextLayoutUnits(layer.text ?? layer.name);
  if (units.length === 0) return 0;
  const scale = textRasterResolutionScale(resolutionScale);
  const fontSize = Math.max(1, layer.textStyle?.fontSize ?? layer.size[1] * 0.56) * scale;
  let maximum = 0;
  for (const unit of units) {
    const baseStyle = {
      codePoint: unit.codePoint,
      fillColor: layer.color,
      strokeColor: layer.textStyle?.strokeColor,
      strokeWidth: layer.textStyle?.strokeWidth,
    };
    const open = evaluateTextAnimatorStack(layer.textAnimator.groups, unit, {
      time: openTime,
      evaluateExpression: safeEvaluateTextSelectorExpression,
      baseStyle,
    });
    const close = evaluateTextAnimatorStack(layer.textAnimator.groups, unit, {
      time: closeTime,
      evaluateExpression: safeEvaluateTextSelectorExpression,
      baseStyle,
    });
    maximum = Math.max(maximum, characterTravel(open, close, unit.characterIndex, fontSize, scale));
  }
  return maximum;
}

function animatedTextSceneUnion(
  sceneSets: readonly (readonly FlattenedSceneLayer[])[],
): Map<string, FlattenedSceneLayer> {
  const result = new Map<string, FlattenedSceneLayer>();
  for (const scenes of sceneSets)
    for (const scene of scenes) {
      if (
        scene.layer.kind !== "text" ||
        scene.layer.motionBlur !== true ||
        clampTextAnimationTime(
          scene.layer.textAnimator,
          evaluateLayerSourceTime(scene.layer, scene.localTime),
          countAnimatedTextCharacters(scene.layer.text ?? scene.layer.name),
        ) === undefined
      )
        continue;
      if (!result.has(scene.resourceInstanceId)) result.set(scene.resourceInstanceId, scene);
    }
  return result;
}

function compositionMayContainMotionBlurText(
  composition: Composition,
  project: Project | undefined,
  visited = new Set<string>(),
): boolean {
  if (visited.has(composition.id)) return false;
  visited.add(composition.id);
  for (const layer of composition.layers) {
    if (!layer.visible) continue;
    if (
      layer.kind === "text" &&
      layer.motionBlur === true &&
      clampTextAnimationTime(layer.textAnimator, 0) !== undefined
    )
      return true;
    if (layer.kind !== "precomposition" || !layer.sourceCompositionId) continue;
    const nested = project?.compositions.find(
      (candidate) => candidate.id === layer.sourceCompositionId,
    );
    if (nested && compositionMayContainMotionBlurText(nested, project, visited)) return true;
  }
  return false;
}

function sceneByResourceId(
  scenes: readonly FlattenedSceneLayer[],
): ReadonlyMap<string, FlattenedSceneLayer> {
  const result = new Map<string, FlattenedSceneLayer>();
  for (const scene of scenes)
    if (!result.has(scene.resourceInstanceId)) result.set(scene.resourceInstanceId, scene);
  return result;
}

function compareSceneOrder(
  left: { scene: FlattenedSceneLayer; order: number },
  right: { scene: FlattenedSceneLayer; order: number },
  compositionOrder: ReadonlyMap<string, number>,
): number {
  return (
    (compositionOrder.get(left.scene.selectionId) ?? Number.MAX_SAFE_INTEGER) -
      (compositionOrder.get(right.scene.selectionId) ?? Number.MAX_SAFE_INTEGER) ||
    left.order - right.order ||
    left.scene.instanceId.localeCompare(right.scene.instanceId)
  );
}

function textAnimationTime(scene: FlattenedSceneLayer | undefined): number | undefined {
  if (scene?.layer.kind !== "text") return undefined;
  const localTime = evaluateLayerSourceTime(scene.layer, scene.localTime);
  return clampTextAnimationTime(
    scene.layer.textAnimator,
    localTime,
    countAnimatedTextCharacters(scene.layer.text ?? scene.layer.name),
  );
}

function characterTravel(
  open: EvaluatedTextAnimatorCharacter,
  close: EvaluatedTextAnimatorCharacter,
  characterIndex: number,
  fontSize: number,
  sourceScale: number,
): number {
  const glyphRadius = fontSize * 0.75;
  const position = distance3(open.position, close.position) * sourceScale;
  const anchor = distance3(open.anchorPoint, close.anchorPoint) * sourceScale;
  const scale = distance3(open.scale, close.scale) * glyphRadius;
  const rotation = degreesDistance(open.rotation, close.rotation) * glyphRadius;
  const skew =
    Math.abs(Math.tan(radians(close.skew)) - Math.tan(radians(open.skew))) * glyphRadius +
    radiansDistance(open.skewAxis, close.skewAxis) * glyphRadius;
  const tracking = Math.abs(close.tracking - open.tracking) * (characterIndex + 1) * sourceScale;
  const anchorFraction = Math.abs(close.lineAnchor - open.lineAnchor) / 100;
  const lineAnchor =
    Math.max(Math.abs(open.tracking), Math.abs(close.tracking)) *
    (characterIndex + 1) *
    anchorFraction *
    sourceScale;
  const lineSpacing = distance2(open.lineSpacing, close.lineSpacing) * sourceScale;
  const blur = distance2(open.blur, close.blur) * sourceScale;
  const replacement = open.codePoint === close.codePoint ? 0 : glyphRadius;
  return (
    position +
    anchor +
    scale +
    rotation +
    skew +
    tracking +
    lineAnchor +
    lineSpacing +
    blur +
    replacement
  );
}

function distance2(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
}

function distance3(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (b[0] ?? 0) - (a[0] ?? 0),
    (b[1] ?? 0) - (a[1] ?? 0),
    (b[2] ?? 0) - (a[2] ?? 0),
  );
}

function degreesDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    radiansDistance(a[0] ?? 0, b[0] ?? 0),
    radiansDistance(a[1] ?? 0, b[1] ?? 0),
    radiansDistance(a[2] ?? 0, b[2] ?? 0),
  );
}

function radiansDistance(a: number, b: number): number {
  return Math.abs(radians(b - a));
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
