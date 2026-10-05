import type { AuxiliarySlice } from "../frame-plan/auxiliary-layout";
import { requirePlan } from "../frame-plan/canonical";
import {
  beginAuxiliaryAggregatePass,
  beginAuxiliaryFrontColorPass,
  beginAuxiliaryMrtPass,
  beginAuxiliaryPeelPass,
} from "./auxiliary-buffer-passes";
import type { createAuxiliaryBufferPipelines } from "./auxiliary-buffer-pipelines";
import type { AuxiliaryGeneratorDraw } from "./auxiliary-plan-bindings";
import { AUXILIARY_BUFFER_KINDS, type AuxiliaryBufferKind } from "./render-buffers";

export interface AuxiliaryTargets {
  textures: ReadonlyMap<AuxiliaryBufferKind, GPUTexture>;
  depth?: GPUTexture;
  frontColor?: GPUTexture;
  aggregate?: GPUTexture;
  peeledPosition?: GPUTexture;
  peeledColor?: GPUTexture;
  peelDepth?: GPUTexture;
}
export function validateAuxiliaryTargets(slice: AuxiliarySlice, targets: AuxiliaryTargets): void {
  requirePlan(
    targets.depth && AUXILIARY_BUFFER_KINDS.every((kind) => targets.textures.has(kind)),
    "missing_resource",
    "Planned auxiliary MRT targets are unavailable",
  );
  requirePlan(
    slice.tier < 1 || (targets.frontColor && targets.aggregate),
    "missing_resource",
    "Planned transparency targets are unavailable",
  );
  requirePlan(
    slice.tier < 2 || (targets.peeledPosition && targets.peeledColor && targets.peelDepth),
    "missing_resource",
    "Planned peeled targets are unavailable",
  );
}
export function executeAuxiliaryPasses(input: {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  slice: AuxiliarySlice;
  targets: AuxiliaryTargets;
  pipelines: ReturnType<typeof createAuxiliaryBufferPipelines>;
  vertexBuffer: GPUBuffer;
  ids?: GPUBuffer;
  motion?: GPUBuffer;
  media: readonly (GPUBindGroup | undefined)[];
  generators: readonly AuxiliaryGeneratorDraw[];
}): void {
  const { device, encoder, slice, targets, pipelines } = input;
  const clear = slice.status === "cleared";
  const geometry = (
    pass: GPURenderPassEncoder,
    shape: GPURenderPipeline,
    media: GPURenderPipeline,
    peel?: GPUBindGroup,
  ) => {
    if (clear) return;
    requirePlan(
      input.ids && input.motion,
      "missing_resource",
      "Missing auxiliary vertex attributes",
    );
    pass.setVertexBuffer(0, input.vertexBuffer);
    pass.setVertexBuffer(1, input.ids);
    pass.setVertexBuffer(2, input.motion);
    slice.draws.forEach((draw, i) => {
      const binding = input.media[i];
      pass.setPipeline(binding ? media : shape);
      if (binding) pass.setBindGroup(0, binding);
      if (peel) pass.setBindGroup(1, peel);
      pass.draw(draw.vertex_count, 1, draw.first_vertex, i);
    });
  };
  const mrt = beginAuxiliaryMrtPass(
    encoder,
    clear
      ? "Auxiliary MRT budget fallback · cleared"
      : "Normal + IDs + World Position + Motion Vector MRT",
    targets.textures,
    targets.depth,
  );
  geometry(mrt, pipelines.shape, pipelines.media);
  for (const generator of input.generators) {
    mrt.setPipeline(generator.pipeline);
    mrt.setBindGroup(0, generator.bindGroup);
    mrt.drawIndirect(generator.indirectBuffer, 0);
  }
  mrt.end();
  if (slice.tier >= 1) {
    const front = beginAuxiliaryFrontColorPass(
      encoder,
      clear ? "Auxiliary front color fallback · cleared" : "Front layer color surface",
      targets.frontColor,
      targets.depth,
    );
    geometry(front, pipelines.frontColorShape, pipelines.frontColorMedia);
    front.end();
    const aggregate = beginAuxiliaryAggregatePass(
      encoder,
      clear
        ? "Auxiliary transparency fallback · cleared"
        : "Transparency-weighted world-position surface",
      targets.aggregate,
    );
    geometry(aggregate, pipelines.transparentShape, pipelines.transparentMedia);
    aggregate.end();
  }
  if (slice.tier >= 2) {
    requirePlan(targets.depth, "missing_resource", "Missing auxiliary front depth");
    const bindGroup = clear
      ? undefined
      : device.createBindGroup({
          label: "Auxiliary front-depth peel source",
          layout: pipelines.peelBindGroupLayout,
          entries: [{ binding: 0, resource: targets.depth.createView() }],
        });
    const peel = beginAuxiliaryPeelPass(
      encoder,
      clear ? "Auxiliary depth peel fallback · cleared" : "Second transparent depth layer peel",
      targets.peeledPosition,
      targets.peeledColor,
      targets.peelDepth,
    );
    geometry(peel, pipelines.peelShape, pipelines.peelMedia, bindGroup);
    peel.end();
  }
}
