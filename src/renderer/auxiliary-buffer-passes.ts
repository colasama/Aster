import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  AUXILIARY_BUFFER_KINDS,
  type AuxiliaryBufferKind,
} from "./render-buffers";

export function beginAuxiliaryMrtPass(
  encoder: GPUCommandEncoder,
  label: string,
  textures: ReadonlyMap<AuxiliaryBufferKind, GPUTexture>,
  depth: GPUTexture | undefined,
): GPURenderPassEncoder {
  if (!depth) throw new Error("Auxiliary MRT depth target is unavailable");
  return encoder.beginRenderPass({
    label,
    colorAttachments: AUXILIARY_BUFFER_KINDS.map((kind) => ({
      view: requiredTexture(textures, kind).createView(),
      clearValue: AUXILIARY_BUFFER_DESCRIPTORS[kind].clearValue,
      loadOp: "clear" as const,
      storeOp: "store" as const,
    })),
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
}

export function beginAuxiliaryPeelPass(
  encoder: GPUCommandEncoder,
  label: string,
  worldPosition: GPUTexture | undefined,
  color: GPUTexture | undefined,
  depth: GPUTexture | undefined,
): GPURenderPassEncoder {
  if (!worldPosition || !color || !depth)
    throw new Error("Auxiliary peeled transparency targets are unavailable");
  return encoder.beginRenderPass({
    label,
    colorAttachments: [worldPosition, color].map((texture) => ({
      view: texture.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: "clear" as const,
      storeOp: "store" as const,
    })),
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "discard",
    },
  });
}

export function beginAuxiliaryFrontColorPass(
  encoder: GPUCommandEncoder,
  label: string,
  color: GPUTexture | undefined,
  depth: GPUTexture | undefined,
): GPURenderPassEncoder {
  if (!color || !depth) throw new Error("Auxiliary front color target is unavailable");
  return encoder.beginRenderPass({
    label,
    colorAttachments: [
      {
        view: color.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: depth.createView(),
      depthLoadOp: "load",
      depthStoreOp: "store",
    },
  });
}

export function beginAuxiliaryAggregatePass(
  encoder: GPUCommandEncoder,
  label: string,
  worldPosition: GPUTexture | undefined,
): GPURenderPassEncoder {
  if (!worldPosition) throw new Error("Auxiliary transparency target is unavailable");
  return encoder.beginRenderPass({
    label,
    colorAttachments: [
      {
        view: worldPosition.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
}

function requiredTexture(
  textures: ReadonlyMap<AuxiliaryBufferKind, GPUTexture>,
  kind: AuxiliaryBufferKind,
): GPUTexture {
  const texture = textures.get(kind);
  if (!texture) throw new Error(`Auxiliary ${kind} target is unavailable`);
  return texture;
}
