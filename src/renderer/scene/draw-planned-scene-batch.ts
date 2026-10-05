import type { BlendMode } from "../../core/types";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import type { SceneDrawPlan } from "./scene-draw-plan";

export function drawPlannedSceneBatch(
  resources: RendererResources,
  pass: GPURenderPassEncoder,
  draw: SceneDrawPlan,
  mediaBindings: MediaBindingLease,
  blendMode: BlendMode = draw.blendMode,
): void {
  const texture = draw.texture;
  const surface =
    texture.kind === "surface"
      ? resources.precompositionSurfaces.bindingFor(texture.instanceId)
      : undefined;
  const media =
    texture.kind === "media"
      ? mediaBindings.bindingForHash(texture.hash)
      : texture.kind === "raster-cache"
        ? resources.mediaTextures.bindGroup(texture.instanceId)
        : undefined;
  pass.setVertexBuffer(0, resources.shapeBuffer);
  if (surface) {
    pass.setPipeline(resources.precompositionSurfaces.pipelineFor(blendMode));
    pass.setBindGroup(0, surface);
    pass.draw(draw.vertexCount, 1, draw.firstVertex);
    return;
  }
  if (texture.kind === "surface") return;
  const material = resources.materialTextures?.bindingFor(draw.material, blendMode);
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
  pass.draw(draw.vertexCount, 1, draw.firstVertex);
}
