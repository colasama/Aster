import type { BlendMode, EnvironmentLighting } from "../../core/types";
import type { GeometryBatch } from "../geometry/geometry";
import type { RendererResources } from "../renderer-resources";
export function drawSceneBatch(
  resources: RendererResources,
  pass: GPURenderPassEncoder,
  batch: GeometryBatch,
  blendMode: BlendMode = batch.layer.blendMode,
  environment?: EnvironmentLighting,
): void {
  const surface =
    batch.layer.kind === "precomposition"
      ? resources.precompositionSurfaces.bindingFor(batch.instanceId)
      : undefined;
  const media =
    batch.layer.kind === "image" || batch.layer.kind === "video" || batch.layer.kind === "text"
      ? resources.mediaTextures.bindGroup(batch.resourceInstanceId)
      : undefined;
  pass.setVertexBuffer(0, resources.shapeBuffer);
  if (surface) {
    pass.setPipeline(resources.precompositionSurfaces.pipelineFor(blendMode));
    pass.setBindGroup(0, surface);
    pass.draw(batch.vertexCount, 1, batch.firstVertex);
    return;
  }
  if (batch.layer.kind === "precomposition") return;
  const material = resources.materialTextures?.bindingFor(
    batch.layer,
    batch.resourceInstanceId,
    blendMode,
    environment,
  );
  if (material) {
    pass.setPipeline(material.pipeline);
    pass.setBindGroup(0, resources.lightingBindGroup);
    pass.setBindGroup(1, material.bindGroup);
  } else if (media) {
    pass.setPipeline(resources.imagePipelines[blendMode]);
    pass.setBindGroup(0, media);
  } else {
    pass.setPipeline(resources.shapePipelines[blendMode]);
    pass.setBindGroup(0, resources.lightingBindGroup);
  }
  pass.draw(batch.vertexCount, 1, batch.firstVertex);
}
