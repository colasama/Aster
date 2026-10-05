import { LayerEffectRenderer } from "../../../src/renderer/effects/layer-effects";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { readLayerEffectSlice } from "../../../src/renderer/frame-plan/layer-effect-plan";
import type { PutResource } from "../../../src/renderer/frame-plan/types";
import {
  LutSelectionPlanner,
  suppliedLutResource,
} from "../../../src/renderer/media/lut-selection-plan";
import { uploadTexturePixels } from "../../../src/renderer/media/texture-pixel-upload";
import { drawEffect } from "./draw";
import { lutDrawFixtures } from "./fixtures";
import { LegacyLayerEffectRenderer } from "./legacy-effects";

async function capture() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const legacy = new LegacyLayerEffectRenderer(device, "rgba16float");
  const producer = new LayerEffectRenderer(device, "rgba16float");
  legacy.resize(64, 48);
  producer.resize(64, 48);
  try {
    const fixture = lutDrawFixtures();
    const source = device.createTexture({
      size: [64, 48],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    device.queue.writeTexture(
      { texture: source },
      fixture.source.bytes,
      { bytesPerRow: 512 },
      [64, 48],
    );
    const resources = new Map([[fixture.source.message.hash, fixture.source]]);
    const cases = [];
    const planner = new LutSelectionPlanner();
    for (const item of fixture.cases) {
      const lut = planner.prepare(item.id, item.layer);
      const prepared = producer.prepareEffect(
        fixture.composition,
        item.layer,
        item.id,
        0.375,
        fixture.header,
        lut,
      );
      if (prepared.status !== "ready") throw Error("Missing fixture effect");
      const resource = suppliedLutResource(lut);
      resources.set(resource.message.hash, resource);
      const reference = await drawEffect(device, source, (encoder, target, draw) => {
        if (item.layer.kind === "adjustment")
          legacy.encodeAdjustment(
            encoder,
            target,
            fixture.composition,
            item.layer,
            item.id,
            0.375,
            lut,
          );
        else
          legacy.encode(
            encoder,
            target,
            fixture.composition,
            item.layer,
            item.id,
            0.375,
            lut,
            draw,
          );
      });
      cases.push({
        id: item.id,
        plan: Array.from(encodeFramePlan(prepared.plan.metadata, prepared.plan.blobs)),
        execution: Array.from(
          encodeFramePlan(prepared.execution.metadata, prepared.execution.blobs),
        ),
        reference,
      });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return {
      cases,
      sourceHash: fixture.source.message.hash,
      resources: Array.from(resources.values(), (r) => ({
        message: r.message,
        bytes: Array.from(r.bytes),
      })),
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
    };
  } finally {
    legacy.destroy();
    producer.destroy();
    device.destroy();
  }
}

async function replay(input: {
  sourceHash: string;
  cases: { id: string; plan: number[]; execution: number[] }[];
  resources: { message: PutResource; bytes: number[] }[];
}) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const consumer = new LayerEffectRenderer(device, "rgba16float");
  consumer.resize(64, 48);
  try {
    const resources = new Map(
      input.resources.map((r) => [
        r.message.hash,
        { message: r.message, bytes: new Uint8Array(r.bytes), label: "Supplied LUT" },
      ]),
    );
    const suppliedSource = resources.get(input.sourceHash);
    if (!suppliedSource) throw Error("Missing supplied source");
    const uploaded = uploadTexturePixels(
      device,
      suppliedSource.message,
      suppliedSource.bytes,
      "Supplied source",
    );
    // The production uploader's source texture is sampled into each layer. Adjustment input
    // also needs COPY_SRC for the diagnostic target initialization.
    const source = device.createTexture({
      size: [64, 48],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    device.queue.writeTexture(
      { texture: source },
      suppliedSource.bytes,
      { bytesPerRow: 512 },
      [64, 48],
    );
    uploaded.destroy();
    const results = [];
    for (const item of input.cases) {
      const plan = decodeFramePlan(new Uint8Array(item.plan));
      const effect = readLayerEffectSlice(plan);
      const resource = resources.get(effect.slice.lut_hash);
      if (resource?.message.kind !== "texture_pixels") throw Error("Missing supplied LUT");
      const prepared = {
        status: "ready" as const,
        execution: decodeFramePlan(new Uint8Array(item.execution)),
        plan,
        lut: { status: "ready" as const, resource: { ...resource, message: resource.message } },
      };
      const pixels = await drawEffect(device, source, (encoder, target, draw) => {
        if (effect.slice.route === "adjustment")
          consumer.encodeAdjustment(encoder, target, prepared);
        else consumer.encode(encoder, target, prepared, draw);
      });
      results.push({ id: item.id, pixels });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    consumer.destroy();
    device.destroy();
  }
}
Object.assign(window, { captureLutDraws: capture, replayLutDraws: replay });
