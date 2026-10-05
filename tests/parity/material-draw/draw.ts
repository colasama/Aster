import type { MaterialGpuBindings } from "../../../src/renderer/media/material-gpu-bindings";
import type { MaterialBindingPlan } from "../../../src/renderer/media/material-texture-plan";
import { createShapePipelines } from "../../../src/renderer/scene/scene-pipelines";

export function lightingLayout(device: GPUDevice) {
  return device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth", viewDimension: "2d" },
      },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    ],
  });
}

export async function drawMaterial(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  consumer: Pick<MaterialGpuBindings, "bindingFor">,
  buffers: {
    lighting: Uint8Array;
    vertices: Uint8Array;
    draws: { firstVertex: number; vertexCount: number }[];
  },
  material: MaterialBindingPlan,
) {
  const lighting = device.createBuffer({
    size: buffers.lighting.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const vertices = device.createBuffer({
    size: buffers.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const shadow = device.createTexture({
    size: [1, 1],
    format: "depth24plus",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
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
    size: 64 * 48 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    device.queue.writeBuffer(
      lighting,
      0,
      buffers.lighting.buffer,
      buffers.lighting.byteOffset,
      buffers.lighting.byteLength,
    );
    device.queue.writeBuffer(
      vertices,
      0,
      buffers.vertices.buffer,
      buffers.vertices.byteOffset,
      buffers.vertices.byteLength,
    );
    const lightGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: lighting } },
        { binding: 1, resource: shadow.createView() },
        {
          binding: 2,
          resource: device.createSampler({
            compare: "less-equal",
            minFilter: "linear",
            magFilter: "linear",
          }),
        },
      ],
    });
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: shadow.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      })
      .end();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    const binding = consumer.bindingFor(material, "normal");
    pass.setPipeline(
      binding?.pipeline ?? createShapePipelines(device, "rgba16float", layout).normal,
    );
    pass.setBindGroup(0, lightGroup);
    if (binding) pass.setBindGroup(1, binding.bindGroup);
    pass.setVertexBuffer(0, vertices);
    for (const draw of buffers.draws) pass.draw(draw.vertexCount, 1, draw.firstVertex);
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
    for (const resource of [lighting, vertices, shadow, target, depth, readback])
      resource.destroy();
  }
}
