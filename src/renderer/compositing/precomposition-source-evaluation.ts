import { type FlattenedSceneLayer, flattenSceneLayers } from "../../core/scene/scene-evaluation";
import type { Composition, Project } from "../../core/types";
import { buildSceneGeometry } from "../geometry/geometry";
import { evaluateSceneCamera } from "../scene/scene-camera";
import { buildSceneLighting } from "../scene/scene-lighting";
import { planTextMotionBlurFrame, type TextMotionBlurPlan } from "../text/text-motion-blur-plan";
import type { TextRasterBounds } from "../text/text-raster-bounds";
import { needsLayerIsolation } from "./layer-composite";
import type { PrecompositionTarget } from "./precomposition-scene-plan";
import {
  createPrecompositionSurfaceBudget,
  planPrecompositionSurface,
  precompositionSurfaceCacheKey,
} from "./precomposition-surface-plan";

export interface EvaluatedPrecompositionSource {
  target: PrecompositionTarget;
  composition: Composition;
  time: number;
  layers: readonly FlattenedSceneLayer[];
}
export type PrecompositionPreparation =
  | { kind: "target"; target: PrecompositionTarget }
  | {
      kind: "media";
      scene: FlattenedSceneLayer;
      resolutionScale: number;
      textMotionBlur?: TextMotionBlurPlan;
    }
  | { kind: "scene"; source: EvaluatedPrecompositionSource };

/** Evaluate recursive source times and resource decisions without allocating GPU objects. */
export function evaluatePrecompositionSources(input: {
  project?: Project;
  sceneLayers: readonly FlattenedSceneLayer[];
  revision: number;
  maxTextureDimension: number;
  memoryBudgetMb?: number;
  enableTextMotionBlur?: boolean;
  renderScale?: number;
}) {
  const { memoryBudgetMb, enableTextMotionBlur = true, renderScale = 1 } = input;
  const operations: PrecompositionPreparation[] = [];
  const bindings = new Map<string, string>();
  const preparedSources = new Map<string, string>();
  const preparedKeys = new Set<string>();
  const diagnostics: string[] = [];
  const budget = createPrecompositionSurfaceBudget();
  function visit(scene: FlattenedSceneLayer): void {
    const surface = scene.precompositionSurface;
    if (!surface) return;
    const logicalKey = `${input.revision}:${surface.composition.id}:${surface.time.toFixed(9)}`;
    const shared = preparedSources.get(logicalKey);
    if (shared) {
      bindings.set(scene.instanceId, shared);
      return;
    }
    let childLayers: FlattenedSceneLayer[];
    try {
      childLayers = namespaceSurfaceLayers(
        flattenSceneLayers(surface.composition, input.project, surface.time),
        scene.resourceInstanceId,
        surface.compositionPath,
      );
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      return;
    }
    const hasEffects = childLayers.some(
      (child) => child.layer.kind === "adjustment" || needsLayerIsolation(child.layer),
    );
    const plan = planPrecompositionSurface(
      {
        scene,
        deviceMaxTextureDimension: input.maxTextureDimension,
        memoryBudgetMb,
        hasEffects,
        renderScale,
      },
      budget,
    );
    if (plan.diagnostic) diagnostics.push(plan.diagnostic);
    if (renderScale > 1 && (plan.status === "skipped" || plan.downgraded))
      throw new Error(
        `SSAA precomposition target unavailable: ${plan.diagnostic}. Choose a lower AA mode or resolution.`,
      );
    if (plan.status === "skipped") return;
    const key = precompositionSurfaceCacheKey(scene, input.revision, plan.width, plan.height);
    const target: PrecompositionTarget = {
      id: key,
      width: plan.width,
      height: plan.height,
      estimatedBytes: plan.estimatedBytes,
      textureCount: plan.textureCount,
      hasEffects,
    };
    preparedSources.set(logicalKey, key);
    bindings.set(scene.instanceId, key);
    if (preparedKeys.has(key)) return;
    preparedKeys.add(key);
    operations.push({ kind: "target", target });

    const resolutionScale = Math.max(
      target.width / Math.max(1, surface.composition.width),
      target.height / Math.max(1, surface.composition.height),
    );
    const textMotionBlur = enableTextMotionBlur
      ? planTextMotionBlurFrame({
          composition: surface.composition,
          project: input.project,
          frameTime: surface.time,
          sceneLayers: childLayers,
          resolutionScale,
          evaluateSceneLayers: (sampleTime) =>
            namespaceSurfaceLayers(
              flattenSceneLayers(surface.composition, input.project, sampleTime),
              scene.resourceInstanceId,
              surface.compositionPath,
            ),
        })
      : {
          sampleCount: 0,
          plans: new Map(),
          exposureSceneLayers: [],
          renderSceneLayers: childLayers,
        };
    childLayers = [...textMotionBlur.renderSceneLayers];
    for (const child of childLayers) {
      if (["text", "image", "video"].includes(child.layer.kind))
        operations.push({
          kind: "media",
          scene: child,
          resolutionScale,
          textMotionBlur: textMotionBlur.plans.get(child.resourceInstanceId),
        });
      if (child.precompositionSurface) visit(child);
    }
    operations.push({
      kind: "scene",
      source: { target, composition: surface.composition, time: surface.time, layers: childLayers },
    });
  }
  if (input.project) for (const scene of input.sceneLayers) visit(scene);
  return { operations, bindings, activeKeys: preparedKeys, diagnostics, budget };
}

function namespaceSurfaceLayers(
  layers: readonly FlattenedSceneLayer[],
  surfaceKey: string,
  compositionPath: readonly string[],
): FlattenedSceneLayer[] {
  return layers.map((child) => ({
    ...child,
    // Standalone evaluation starts every source at `root`. Namespace both identities by the stable
    // outer wrapper resource path: separate wrappers cannot overwrite each other, clones share,
    // and playback does not churn media resources merely because the sample time moved.
    instanceId: namespaceSurfaceChild(surfaceKey, child.instanceId),
    resourceInstanceId: namespaceSurfaceChild(surfaceKey, child.resourceInstanceId),
    precompositionSurface: child.precompositionSurface
      ? {
          ...child.precompositionSurface,
          compositionPath: [...compositionPath, ...child.precompositionSurface.compositionPath],
        }
      : undefined,
  }));
}

function namespaceSurfaceChild(surfaceKey: string, relativeId: string): string {
  return `surface:${surfaceKey}/${relativeId}`;
}

/** Geometry consumes evaluated children and supplied raster bounds, never GPU resources. */
export function evaluatePrecompositionGeometry(
  source: EvaluatedPrecompositionSource,
  textBounds: (instanceId: string) => TextRasterBounds | undefined,
) {
  const childLayers = [...source.layers];
  const diagnostics: string[] = [];
  const camera = evaluateSceneCamera(source.composition, source.time);
  const geometry = buildSceneGeometry(source.composition, childLayers, camera, (instanceId) =>
    textBounds(instanceId),
  );
  if (
    source.composition.environment?.enabled &&
    geometry.batches.some((batch) => batch.layer.kind === "mesh")
  )
    diagnostics.push(
      `${source.composition.name}: HDR environment lighting is not sampled inside precomposition surfaces`,
    );
  if (
    geometry.batches.some(
      (batch) => batch.layer.kind === "mesh" && batch.layer.mesh?.materialTextures?.normal,
    )
  )
    diagnostics.push(
      `${source.composition.name}: mesh normal maps are not sampled inside precomposition surfaces`,
    );
  if (
    childLayers.some(
      (child) => child.layer.kind === "light" && child.layer.light?.shadowQuality !== "off",
    ) &&
    geometry.batches.some((batch) => batch.layer.threeDimensional)
  )
    diagnostics.push(
      `${source.composition.name}: child shadow maps are not encoded inside precomposition surfaces`,
    );
  return {
    camera,
    geometry,
    diagnostics,
    lighting: buildSceneLighting(childLayers, source.composition, false, camera?.pose.position),
  };
}
