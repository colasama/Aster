import { decodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { FrameResourceRegistry } from "../../../src/renderer/frame-plan/resources";
import { readTemporalPassSlice } from "../../../src/renderer/frame-plan/temporal-pass-plan";
import type { PutResource } from "../../../src/renderer/frame-plan/types";
import { GpuFrameReadbackPool } from "../../../src/renderer/gpu/frame-readback";
import { sharedShaders } from "../../../src/renderer/gpu/shared-shader-catalog";
import {
  destroyMediaResource,
  type MediaResource,
} from "../../../src/renderer/media/media-resource";
import { uploadRasterResource } from "../../../src/renderer/media/raster-resource-upload";
import { executeTemporalTextPassPlan } from "../../../src/renderer/text/text-motion-blur-pass-plan";

interface ReplayInput {
  pass: number[];
  output: PutResource[];
  samples: { messages: PutResource[]; pixels: number[] }[];
}

/** Fresh GPU allocations from transport data only; this module imports no authoring evaluators. */
export async function replayTemporalPass(input: ReplayInput) {
  const decoded = decodeFramePlan(new Uint8Array(input.pass));
  const plan = readTemporalPassSlice(decoded);
  const scope = decoded.metadata.header.snapshot_scope;
  const registry = new FrameResourceRegistry({
    budget_bytes: 256 * 1024 * 1024,
    max_resources: 16384,
  });
  for (const message of input.output) await registry.apply(message);
  for (const sample of input.samples)
    for (const message of sample.messages)
      await registry.apply(
        message,
        message.kind === "raster_pixels" ? new Uint8Array(sample.pixels) : undefined,
      );
  const outputDescriptor = registry.resolve(plan.output).content;
  if (
    outputDescriptor.kind !== "media_frame" ||
    outputDescriptor.descriptor.width !== plan.width ||
    outputDescriptor.descriptor.height !== plan.height
  )
    throw new Error("Replay output differs from the supplied plan");
  const source = registry.resolve(outputDescriptor.descriptor.source).content;
  if (source.kind !== "media_source" || source.descriptor.authorization_scope !== scope)
    throw new Error("Replay output scope differs");
  if (input.samples.length !== plan.samples.length) throw new Error("Replay sample count differs");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("Replay requires WebGPU");
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  device.pushErrorScope("validation");
  const owners: MediaResource[] = [];
  const textures: GPUTexture[] = [];
  const buffers: GPUBuffer[] = [];
  const pool = new GpuFrameReadbackPool(device, "rgba8unorm-srgb", 1);
  try {
    const sampleLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    const resolveLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    const module = device.createShaderModule({
      code: sharedShaders.source("text-motion-blur-raster"),
    });
    const accumulatePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [sampleLayout] }),
      vertex: { module, entryPoint: "vertex_main" },
      primitive: { topology: "triangle-list" },
      fragment: {
        module,
        entryPoint: "accumulate_fragment",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
    });
    const resolvePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [resolveLayout] }),
      vertex: { module, entryPoint: "vertex_main" },
      primitive: { topology: "triangle-list" },
      fragment: {
        module,
        entryPoint: "resolve_fragment",
        targets: [{ format: "rgba8unorm-srgb" }],
      },
    });
    const output = device.createTexture({
      size: [plan.width, plan.height],
      format: plan.output_format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING,
    });
    textures.push(output);
    const accumulation = device.createTexture({
      size: [plan.width, plan.height],
      format: plan.accumulation_format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    textures.push(accumulation);
    const weights = plan.samples.length
      ? device.createBuffer({
          size: plan.samples.length * 256,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
      : undefined;
    if (weights) buffers.push(weights);
    const outputBinding = device.createBindGroup({
      layout: resolveLayout,
      entries: [{ binding: 0, resource: output.createView() }],
    });
    const bindings = new Map([[plan.output, outputBinding]]);
    for (let index = 0; index < input.samples.length; index++) {
      const sample = input.samples[index];
      const pixel = sample.messages.find((message) => message.kind === "raster_pixels");
      if (!pixel || !weights) throw new Error("Replay sample pixels or weights absent");
      const installed = uploadRasterResource(registry, pixel.hash, scope, {
        device,
        maximumDimension: 8192,
        maximumBytes: 256 * 1024 * 1024,
        label: "Decoded temporal sample",
        createBindGroup: (texture) =>
          device.createBindGroup({
            layout: sampleLayout,
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: sampler },
              { binding: 2, resource: { buffer: weights, offset: index * 256, size: 16 } },
            ],
          }),
      });
      owners.push(installed.resource);
      if (
        installed.frameHash !== plan.samples[index].hash ||
        installed.resource.textureWidth !== plan.width ||
        installed.resource.textureHeight !== plan.height
      )
        throw new Error("Replay sample differs from the planned slot");
      if (!installed.resource.bindGroup) throw new Error("Missing replay sample binding");
      bindings.set(installed.frameHash, installed.resource.bindGroup);
    }
    const encoder = device.createCommandEncoder();
    executeTemporalTextPassPlan(
      plan,
      {
        hashFor: (id) =>
          id === "output" ? plan.output : plan.samples[Number(id.split(":")[1])].hash,
        bindingForHash: (hash) => bindings.get(String(hash)),
      },
      encoder,
      {
        queue: device.queue,
        width: plan.width,
        height: plan.height,
        output,
        outputBinding,
        accumulation,
        weights,
        resolveBinding: device.createBindGroup({
          layout: resolveLayout,
          entries: [{ binding: 0, resource: accumulation.createView() }],
        }),
        accumulatePipeline,
        resolvePipeline,
      },
    );
    const ticket = pool.reserve(plan.width, plan.height);
    ticket.encode(encoder, output);
    device.queue.submit([encoder.finish()]);
    const pixels = (await ticket.read()).pixels;
    const scoped = await device.popErrorScope();
    if (scoped) errors.push(scoped.message);
    if (errors.length) throw new Error(errors.join("\n"));
    return Array.from(new Uint8Array(pixels));
  } finally {
    pool.destroy();
    for (const owner of owners) destroyMediaResource(owner);
    for (const buffer of buffers) buffer.destroy();
    for (const texture of textures) texture.destroy();
    device.destroy();
  }
}
