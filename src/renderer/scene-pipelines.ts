import type { BlendMode } from "../core/types";
import { FLOATS_PER_VERTEX } from "./geometry";
import { imageShader, shadowShader, shapeShader } from "./shaders";

const BLEND_MODES: BlendMode[] = ["normal", "add", "multiply", "screen", "overlay"];

export function createShapePipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  bindGroupLayout: GPUBindGroupLayout,
): Record<BlendMode, GPURenderPipeline> {
  const module = device.createShaderModule({ label: "GPU-lit shape shader", code: shapeShader });
  const layout = device.createPipelineLayout({
    label: "GPU-lit shape pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });
  return createBlendPipelines(device, "GPU-resident layer composite", (blendMode) => ({
    label: `GPU-resident ${blendMode} layer composite`,
    layout,
    vertex: {
      module,
      entryPoint: "vertex_main",
      buffers: [
        {
          arrayStride: FLOATS_PER_VERTEX * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x2" },
            { shaderLocation: 2, offset: 20, format: "float32x4" },
            { shaderLocation: 3, offset: 36, format: "float32" },
            { shaderLocation: 4, offset: 40, format: "float32x3" },
            { shaderLocation: 5, offset: 52, format: "float32x4" },
            { shaderLocation: 6, offset: 68, format: "float32x3" },
            { shaderLocation: 7, offset: 80, format: "float32x4" },
            { shaderLocation: 8, offset: 96, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fragment_main",
      targets: [{ format, blend: blendState(blendMode) }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  }));
}

export function createImagePipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  bindGroupLayout: GPUBindGroupLayout,
): Record<BlendMode, GPURenderPipeline> {
  const module = device.createShaderModule({ label: "Imported media shader", code: imageShader });
  const layout = device.createPipelineLayout({
    label: "Imported media pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });
  return createBlendPipelines(device, "GPU-resident media layer", (blendMode) => ({
    label: `GPU-resident ${blendMode} sRGB media layer`,
    layout,
    vertex: {
      module,
      entryPoint: "vertex_main",
      buffers: [
        {
          arrayStride: FLOATS_PER_VERTEX * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x2" },
            { shaderLocation: 2, offset: 20, format: "float32x4" },
            { shaderLocation: 3, offset: 36, format: "float32" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fragment_main",
      targets: [{ format, blend: blendState(blendMode) }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  }));
}

export function createShadowPipeline(
  device: GPUDevice,
  bindGroupLayout: GPUBindGroupLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ label: "Scene shadow shader", code: shadowShader });
  return device.createRenderPipeline({
    label: "GPU shadow-map depth pass",
    layout: device.createPipelineLayout({
      label: "GPU shadow-map pipeline layout",
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: {
      module,
      entryPoint: "vertex_main",
      buffers: [
        {
          arrayStride: FLOATS_PER_VERTEX * 4,
          attributes: [{ shaderLocation: 6, offset: 68, format: "float32x3" }],
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
      depthBias: 2,
      depthBiasSlopeScale: 1.5,
    },
  });
}

function createBlendPipelines(
  device: GPUDevice,
  label: string,
  descriptor: (blendMode: BlendMode) => GPURenderPipelineDescriptor,
): Record<BlendMode, GPURenderPipeline> {
  return Object.fromEntries(
    BLEND_MODES.map((blendMode) => [
      blendMode,
      device.createRenderPipeline({ ...descriptor(blendMode), label: `${label} · ${blendMode}` }),
    ]),
  ) as Record<BlendMode, GPURenderPipeline>;
}

function blendState(mode: BlendMode): GPUBlendState {
  const alpha: GPUBlendComponent = {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  };
  if (mode === "add")
    return { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha };
  if (mode === "multiply")
    return { color: { srcFactor: "dst", dstFactor: "zero", operation: "add" }, alpha };
  if (mode === "screen")
    return {
      color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
      alpha,
    };
  return {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha,
  };
}
