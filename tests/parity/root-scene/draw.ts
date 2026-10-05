import type { executeRootScene } from "../../../src/renderer/compositing/execute-root-scene";
import type { LayerEffectRenderer } from "../../../src/renderer/effects/layer-effects";
import type { RendererResources } from "../../../src/renderer/renderer-resources";
import { createShapePipelines } from "../../../src/renderer/scene/scene-pipelines";
import { lightingLayout } from "../material-draw/draw";
export type DrawContext = Pick<
  Parameters<typeof executeRootScene>[0],
  "resources" | "encoder" | "sceneTexture" | "sceneView" | "depthView"
>;
export async function drawRoot(
  device: GPUDevice,
  buffers: { lighting: Uint8Array; vertices: Uint8Array },
  effects: LayerEffectRenderer,
  execute: (input: DrawContext) => ReturnType<typeof executeRootScene>,
) {
  const layout = lightingLayout(device);
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
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.TEXTURE_BINDING,
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
    const resources = {
      shapeBuffer: vertices,
      lightingBindGroup: lightGroup,
      shapePipelines: createShapePipelines(device, "rgba16float", layout),
      layerEffects: effects,
      gpuProfiler: { writes: () => undefined },
    } as unknown as RendererResources;
    const metrics = execute({
      resources,
      encoder,
      sceneTexture: target,
      sceneView: target.createView(),
      depthView: depth.createView(),
    });
    if (metrics.adjustmentErrors.length) throw Error(JSON.stringify(metrics.adjustmentErrors));
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 512, rowsPerImage: 48 },
      [64, 48],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = Array.from(new Uint8Array(readback.getMappedRange()));
    readback.unmap();
    return {
      pixels,
      metrics: { ...metrics, activeEffectInstances: Array.from(metrics.activeEffectInstances) },
    };
  } finally {
    for (const resource of [lighting, vertices, shadow, target, depth, readback])
      resource.destroy();
  }
}
