import type { BlendMode } from "../../core/types";
import { requirePlan } from "../frame-plan/canonical";
import type { GeometryBatch } from "../geometry/geometry";
import type { MaterialBindingPlan } from "../media/material-texture-plan";

export type SceneTextureReference =
  | { kind: "surface"; instanceId: string }
  | { kind: "media"; hash: string | null }
  | { kind: "raster-cache"; instanceId: string }
  | { kind: "none" };

/** Owned draw inputs; resource lookup happens against the frame's retained GPU owners. */
export interface SceneDrawPlan {
  instanceId: string;
  firstVertex: number;
  vertexCount: number;
  blendMode: BlendMode;
  texture: SceneTextureReference;
  material?: MaterialBindingPlan;
}

export function planSceneDraw(batch: GeometryBatch): SceneDrawPlan {
  let texture: SceneTextureReference;
  if (batch.layer.kind === "precomposition") {
    texture = { kind: "surface", instanceId: batch.instanceId };
  } else if (
    batch.layer.kind === "image" ||
    batch.layer.kind === "video" ||
    batch.mediaResourceHash !== undefined
  ) {
    requirePlan(
      batch.mediaResourceHash !== undefined,
      "missing_resource",
      "Media hash is absent from the frame",
    );
    texture = { kind: "media", hash: batch.mediaResourceHash };
  } else if (batch.layer.kind === "text") {
    texture = { kind: "raster-cache", instanceId: batch.resourceInstanceId };
  } else texture = { kind: "none" };
  return {
    instanceId: batch.instanceId,
    firstVertex: batch.firstVertex,
    vertexCount: batch.vertexCount,
    blendMode: batch.layer.blendMode,
    texture,
    ...(batch.materialTexturePlan ? { material: { ...batch.materialTexturePlan } } : {}),
  };
}
