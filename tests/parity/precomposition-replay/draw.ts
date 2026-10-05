import type { BlendMode } from "../../../src/core/types";
import { FLOATS_PER_VERTEX } from "../../../src/renderer/geometry/geometry";
import {
  createImagePipelines,
  createShapePipelines,
} from "../../../src/renderer/scene/scene-pipelines";
import { lightingLayout } from "../material-draw/draw";

export function surfaceOptions(device: GPUDevice) {
  const mediaLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const lighting = lightingLayout(device);
  return {
    mediaLayout,
    lightingLayout: lighting,
    mediaSampler: device.createSampler({ minFilter: "linear", magFilter: "linear" }),
    shapePipelines: createShapePipelines(device, "rgba16float", lighting),
    imagePipelines: createImagePipelines(device, "rgba16float", mediaLayout),
  };
}

export async function drawSurface(
  device: GPUDevice,
  renderer: {
    bindingFor(id: string): GPUBindGroup | undefined;
    pipelineFor(blend: BlendMode): GPURenderPipeline;
  },
  output: string,
  execute: (encoder: GPUCommandEncoder) => void,
) {
  const target = device.createTexture({
    size: [64, 48],
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = device.createTexture({
    size: [64, 48],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const readback = device.createBuffer({
    size: 24576,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const data = new Float32Array(6 * FLOATS_PER_VERTEX);
  [
    [-1, 1, 0, 0],
    [1, 1, 1, 0],
    [-1, -1, 0, 1],
    [-1, -1, 0, 1],
    [1, 1, 1, 0],
    [1, -1, 1, 1],
  ].forEach(([x, y, u, v], i) => {
    data.set([x, y, 0, u, v, 1, 1, 1, 1, 1], i * FLOATS_PER_VERTEX);
  });
  const vertices = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
  });
  try {
    device.queue.writeBuffer(vertices, 0, data);
    const encoder = device.createCommandEncoder();
    execute(encoder);
    const binding = renderer.bindingFor(output);
    if (!binding) throw Error("Output alias is absent");
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.setPipeline(renderer.pipelineFor("normal"));
    pass.setBindGroup(0, binding);
    pass.setVertexBuffer(0, vertices);
    pass.draw(6);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 512, rowsPerImage: 48 },
      [64, 48],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = Array.from(new Uint8Array(readback.getMappedRange()));
    readback.unmap();
    return pixels;
  } finally {
    for (const item of [target, depth, readback, vertices]) item.destroy();
  }
}
