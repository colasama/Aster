import type { AuxiliaryDraw, AuxiliaryTexture } from "../frame-plan/auxiliary-layout";
import { auxiliaryTextureKey } from "../frame-plan/auxiliary-plan";
import { compositionIdentityFromString } from "../frame-plan/composition-identity";
import type { FrameHeaderSlice } from "../frame-plan/types";
import type { GeometryBatch } from "../geometry/geometry";
import { buildAuxiliaryBatchIds } from "./auxiliary-buffer-data";

export interface AuxiliaryGeneratorDraw {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  indirectBuffer: GPUBuffer;
}
export interface AuxiliaryPlanBindings {
  media: ReadonlyMap<string, GPUBindGroup>;
  generators: ReadonlyMap<string, AuxiliaryGeneratorDraw>;
}
export interface AuxiliaryPlanRequest {
  header: FrameHeaderSlice;
  vertexCount: number;
  batches: readonly GeometryBatch[];
  motionVectors?: Float32Array;
  mediaBinding: (
    batch: GeometryBatch,
  ) => { texture: AuxiliaryTexture; binding: GPUBindGroup } | undefined;
  generators?: readonly { instanceId: string; draw: AuxiliaryGeneratorDraw }[];
}
export function captureAuxiliaryDraws(input: AuxiliaryPlanRequest) {
  const media = new Map<string, GPUBindGroup>();
  const draws: AuxiliaryDraw[] = input.batches.map((batch) => {
    const supplied = input.mediaBinding(batch);
    const texture = supplied?.texture ?? { kind: "none" as const };
    if (supplied) media.set(auxiliaryTextureKey(texture), supplied.binding);
    return {
      instance_id: compositionIdentityFromString(batch.instanceId),
      first_vertex: batch.firstVertex,
      vertex_count: batch.vertexCount,
      texture,
    };
  });
  const generators = new Map((input.generators ?? []).map((item) => [item.instanceId, item.draw]));
  return {
    draws,
    ids: buildAuxiliaryBatchIds(input.batches),
    generatorIds: (input.generators ?? []).map((item) =>
      compositionIdentityFromString(item.instanceId),
    ),
    bindings: { media, generators },
  };
}
