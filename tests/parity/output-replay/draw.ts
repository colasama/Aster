import { SceneBufferVisualizer } from "../../../src/renderer/diagnostics/buffer-visualizer";
import { GpuTimestampProfiler } from "../../../src/renderer/diagnostics/gpu-timestamp-profiler";
import { AntiAliasingRenderer } from "../../../src/renderer/effects/anti-aliasing";
import type { FrameHeaderSlice } from "../../../src/renderer/frame-plan/types";
import { AUXILIARY_BUFFER_KINDS } from "../../../src/renderer/gpu/render-buffers";
import { createPostPipeline } from "../../../src/renderer/gpu/runtime-pipelines";
import { createLutSampler, createLutTexture } from "../../../src/renderer/media/lut-texture";
import type { Attachment } from "./fixtures";

export function outputResources(
  device: GPUDevice,
  header: FrameHeaderSlice,
  attachments: Attachment[],
  uniforms: Uint8Array,
) {
  const { width, height } = header.render_target;
  const textures = new Map(
    attachments.map((a) => {
      if (a.bytes.length !== width * height * a.bpp)
        throw Error("Invalid supplied attachment size");
      const texture = device.createTexture({
        size: [width, height],
        format: a.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture },
        new Uint8Array(a.bytes),
        { bytesPerRow: width * a.bpp },
        [width, height],
      );
      return [a.role, texture] as const;
    }),
  );
  const texture = (role: string) => {
    const t = textures.get(role);
    if (!t) throw Error(`Missing ${role}`);
    return t;
  };
  const aa = new AntiAliasingRenderer(device, "rgba8unorm");
  aa.resize(header.aa, width, height);
  const pipeline = createPostPipeline(device, "rgba8unorm"),
    sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" }),
    lut = createLutTexture(device);
  const uniform = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    ops = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  device.queue.writeBuffer(uniform, 0, uniforms);
  const binding = (source: GPUTexture) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: uniform } },
        { binding: 3, resource: { buffer: ops } },
        { binding: 4, resource: lut.createView({ dimension: "3d" }) },
        { binding: 5, resource: createLutSampler(device) },
        { binding: 6, resource: source.createView() },
        { binding: 7, resource: source.createView() },
      ],
    });
  const visualizer = new SceneBufferVisualizer(device, "rgba8unorm");
  visualizer.setSource(texture("scene"));
  const range = Math.max(width, height);
  visualizer.setAuxiliarySources(new Map(AUXILIARY_BUFFER_KINDS.map((k) => [k, texture(k)])), [
    -range,
    range,
  ]);
  const profiler = new GpuTimestampProfiler(device, false, () => {});
  const target = device.createTexture({
    size: [header.target.width, header.target.height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  return {
    textures,
    texture,
    aa,
    pipeline,
    binding,
    visualizer,
    profiler,
    target,
    destroy() {
      for (const t of textures.values()) t.destroy();
      aa.destroy();
      lut.destroy();
      uniform.destroy();
      ops.destroy();
      visualizer.destroy();
      profiler.destroy();
      target.destroy();
    },
  };
}
export async function readOutput(device: GPUDevice, target: GPUTexture) {
  const row = Math.ceil((target.width * 4) / 256) * 256,
    buffer = device.createBuffer({
      size: row * target.height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: row }, [
    target.width,
    target.height,
  ]);
  device.queue.submit([encoder.finish()]);
  try {
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange()),
      out = new Uint8Array(target.width * target.height * 4);
    for (let y = 0; y < target.height; y++)
      out.set(bytes.subarray(y * row, y * row + target.width * 4), y * target.width * 4);
    return Array.from(out);
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}
