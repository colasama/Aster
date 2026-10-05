import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { Composition } from "../../core/types";
import { effectExecution, type PreparedLayerEffect } from "../effects/layer-effect-plan";
import { buildGeneratorSlice } from "../frame-plan/generator-plan";
import type { PrecompositionGeneratorExecution } from "../frame-plan/precomposition-bundle-layout";
import { buildSceneBufferPlan } from "../frame-plan/scene-buffer-plan";
import type { FramePlanSliceData } from "../frame-plan/types";
import type { GeometryResult } from "../geometry/geometry";
import type { SceneGeneratorPlan } from "../scene/scene-generator-plan";
import type { GeneratorShaderResource } from "../scene/scene-generator-program";
import { type PlannedSceneItem, planSceneRenderStack } from "./render-stack";
import { planRootSceneCommands, type RootSceneCommand } from "./root-scene-commands";

export interface PrecompositionTarget {
  id: string;
  width: number;
  height: number;
  estimatedBytes: number;
  textureCount: number;
  hasEffects: boolean;
}
export interface PrecompositionDraw {
  sceneDrawIndex: number;
  firstVertex: number;
  vertexCount: number;
  texture:
    | { kind: "surface"; targetId: string | null }
    | { kind: "media"; hash: string | null }
    | { kind: "none" };
}
export type PrecompositionSceneInputs = Omit<PrecompositionScenePlan, "draws"> & {
  draws: (Omit<PrecompositionDraw, "texture"> & {
    texture:
      | Exclude<PrecompositionDraw["texture"], { kind: "media" }>
      | { kind: "media"; instanceId: string };
  })[];
};
/** Owned inputs for one child scene; GPU allocations and authoring objects are outside this plan. */
export interface PrecompositionScenePlan {
  target: PrecompositionTarget;
  label: string;
  scene: FramePlanSliceData;
  commands: RootSceneCommand[];
  draws: PrecompositionDraw[];
  effects: Map<string, PreparedLayerEffect>;
  generators: {
    instanceId: string;
    execution?: PrecompositionGeneratorExecution;
    origin: { layerName: string; pluginId: string };
    plan: FramePlanSliceData;
    shaders: GeneratorShaderResource[];
  }[];
}
export function buildPrecompositionScenePlan(input: {
  target: PrecompositionTarget;
  revision: number;
  composition: Composition;
  time: number;
  layers: readonly FlattenedSceneLayer[];
  geometry: GeometryResult;
  lighting: Float32Array;
  effects: ReadonlyMap<string, PreparedLayerEffect>;
  generators: readonly SceneGeneratorPlan[];
  surfaceTargets: ReadonlyMap<string, string>;
}): PrecompositionSceneInputs {
  const { composition, target } = input;
  const scene = buildSceneBufferPlan({
    snapshot: { snapshotScope: "precomposition-scenes", projectRevision: input.revision },
    compositionId: composition.id,
    time: input.time,
    frameRate: composition.frameRate,
    target: { width: composition.width, height: composition.height },
    renderTarget: { width: target.width, height: target.height },
    antiAliasing: "off",
    geometry: input.geometry,
    lighting: input.lighting,
    shadowsEnabled: false,
  });
  const draws: PrecompositionSceneInputs["draws"] = [];
  const items = planSceneRenderStack(input.layers, input.geometry.batches).map(
    (item): PlannedSceneItem => {
      const base = { instanceId: item.scene.instanceId, clearDepth: item.clearDepth === true };
      if (item.kind !== "geometry") return { ...base, kind: item.kind };
      const batch = item.batch,
        kind = batch.layer.kind,
        drawIndex = draws.length;
      draws.push({
        sceneDrawIndex: input.geometry.batches.indexOf(batch),
        firstVertex: batch.firstVertex,
        vertexCount: batch.vertexCount,
        texture:
          kind === "precomposition"
            ? { kind: "surface", targetId: input.surfaceTargets.get(batch.instanceId) ?? null }
            : kind === "image" || kind === "video" || kind === "text"
              ? { kind: "media", instanceId: batch.resourceInstanceId }
              : { kind: "none" },
      });
      return { ...base, kind: "geometry", drawIndex };
    },
  );
  const effects = structuredClone(new Map(input.effects));
  const commands = planRootSceneCommands(
    { items },
    new Map([...effects].map(([id, p]) => [id, effectExecution(p)])),
    new Set(input.generators.map((p) => p.instanceId)),
    composition.background,
  );
  const generatorHeader = { ...scene.metadata.header, snapshot_scope: "precomposition-generators" };
  return {
    target: { ...target },
    label: composition.name,
    scene,
    commands,
    draws,
    effects,
    generators: input.generators.map((p) => {
      const source = input.layers.find((s) => s.instanceId === p.instanceId);
      if (!source) throw new Error("Generator diagnostic origin is absent");
      return {
        instanceId: p.instanceId,
        origin: { layerName: source.layer.name, pluginId: source.layer.generator?.pluginId ?? "" },
        plan: buildGeneratorSlice(generatorHeader, p),
        shaders: structuredClone(p.program.shaders),
      };
    }),
  };
}
