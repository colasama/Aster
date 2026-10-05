import type { BlendMode } from "../../core/types";
import type { GeometryBatch } from "../geometry/geometry";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import { drawPlannedSceneBatch } from "./draw-planned-scene-batch";
import { planSceneDraw } from "./scene-draw-plan";

/** Adapter for scene consumers that still prepare draws during encoding. */
export function drawSceneBatch(
  resources: RendererResources,
  pass: GPURenderPassEncoder,
  batch: GeometryBatch,
  mediaBindings: MediaBindingLease,
  blendMode: BlendMode = batch.layer.blendMode,
): void {
  drawPlannedSceneBatch(resources, pass, planSceneDraw(batch), mediaBindings, blendMode);
}
