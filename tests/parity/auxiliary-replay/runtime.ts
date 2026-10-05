import type { AuxiliaryTexture } from "../../../src/renderer/frame-plan/auxiliary-layout";
import {
  auxiliaryTextureKey,
  buildAuxiliaryPlan,
  readAuxiliaryPlan,
} from "../../../src/renderer/frame-plan/auxiliary-plan";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { prepareSceneBuffers } from "../../../src/renderer/frame-plan/scene-buffer-upload";
import type { FramePlanSliceData, PutResource } from "../../../src/renderer/frame-plan/types";
import { AuxiliaryBufferRenderer } from "../../../src/renderer/gpu/auxiliary-buffer-renderer";
import { uploadTexturePixels } from "../../../src/renderer/media/texture-pixel-upload";
import { imageLayout, observableDevice, readAuxiliary } from "./draw";
import { auxiliaryGpuFixture } from "./fixtures";
import { LegacyAuxiliaryBufferRenderer } from "./legacy-auxiliary";

type Resource = { texture: AuxiliaryTexture; message: PutResource; pixels: number[] };
type ReplayCase = {
  id: string;
  tier: number;
  scene: number[];
  auxiliary: number[];
  prime?: number[];
  resources: Resource[];
};
const pack = (plan: FramePlanSliceData) => Array.from(encodeFramePlan(plan.metadata, plan.blobs));
const unpack = (bytes: number[]) => decodeFramePlan(new Uint8Array(bytes));
async function devicePair() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice({
    requiredLimits: { maxColorAttachments: 5, maxColorAttachmentBytesPerSample: 28 },
  });
  device.pushErrorScope("validation");
  return { device, adapter };
}
function bindResources(device: GPUDevice, layout: GPUBindGroupLayout, resources: Resource[]) {
  const textures = resources.map((r) =>
    uploadTexturePixels(device, r.message, new Uint8Array(r.pixels), "Supplied auxiliary media"),
  );
  const sampler = device.createSampler({ minFilter: "nearest", magFilter: "nearest" });
  const bindings = new Map(
    resources.map((r, i) => [
      auxiliaryTextureKey(r.texture),
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: textures[i].createView() },
          { binding: 1, resource: sampler },
        ],
      }),
    ]),
  );
  return {
    bindings,
    destroy() {
      for (const t of textures) t.destroy();
    },
  };
}
async function capture() {
  const { device, adapter } = await devicePair(),
    cases = [];
  try {
    for (const id of ["basic", "tier0", "tier1", "tier2", "no-motion", "cleared"]) {
      const fixture = auxiliaryGpuFixture(id),
        layout = imageLayout(device);
      const resources = fixture.resources.map((r) => ({
        texture: r.texture,
        message: r.message,
        pixels: Array.from(r.pixels),
      }));
      const media = bindResources(device, layout, resources),
        byInstance = new Map(fixture.resources.map((r) => [r.instanceId, r]));
      const legacy = new LegacyAuxiliaryBufferRenderer(observableDevice(device), layout),
        producer = new AuxiliaryBufferRenderer(observableDevice(device), layout);
      const budget = 64 * 48 * (32 + (fixture.tier >= 2 ? 36 : fixture.tier >= 1 ? 16 : 0)) + 1024;
      if (
        !legacy.enable(64, 48, budget, fixture.tier >= 0) ||
        !producer.enable(64, 48, budget, fixture.tier >= 0)
      )
        throw Error("Auxiliary allocation failed");
      const request = {
        header: fixture.plan.metadata.header,
        vertexCount: fixture.vertexCount,
        batches: fixture.geometry.batches,
        motionVectors: fixture.motion,
        mediaBinding: (batch: (typeof fixture.geometry.batches)[number]) => {
          const r = byInstance.get(batch.instanceId);
          return r
            ? {
                texture: r.texture,
                binding: media.bindings.get(auxiliaryTextureKey(r.texture)) as GPUBindGroup,
              }
            : undefined;
        },
      };
      const prime = producer.buildPlan(request).plan;
      const auxiliary =
        id === "cleared" ? producer.buildPlan({ ...request, vertexCount: 1000000 }).plan : prime;
      const vertices = device.createBuffer({
        size: fixture.geometry.data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vertices, 0, fixture.geometry.data);
      const encoder = device.createCommandEncoder();
      const legacyRequest = {
        encoder,
        vertexBuffer: vertices,
        vertexCount: fixture.vertexCount,
        batches: fixture.geometry.batches,
        motionVectors: fixture.motion,
        mediaBindGroup: (batch: (typeof fixture.geometry.batches)[number]) =>
          request.mediaBinding(batch)?.binding,
      };
      legacy.encode(legacyRequest);
      if (id === "cleared") legacy.encode({ ...legacyRequest, vertexCount: 1000000 });
      device.queue.submit([encoder.finish()]);
      const reference = await readAuxiliary(device, legacy, fixture.tier);
      cases.push({
        id,
        tier: fixture.tier,
        scene: pack(fixture.plan),
        auxiliary: pack(auxiliary),
        ...(id === "cleared" ? { prime: pack(prime) } : {}),
        resources,
        reference,
      });
      vertices.destroy();
      legacy.destroy();
      producer.destroy();
      media.destroy();
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return {
      cases,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
    };
  } finally {
    device.destroy();
  }
}
async function replay(cases: ReplayCase[]) {
  const { device } = await devicePair(),
    results = [];
  try {
    for (const item of cases) {
      const scene = prepareSceneBuffers(unpack(item.scene)),
        plan = unpack(item.auxiliary),
        layout = imageLayout(device),
        media = bindResources(device, layout, item.resources);
      const vertices = device.createBuffer({
        size: scene.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vertices, 0, scene.vertices);
      const run = async (candidate: FramePlanSliceData) => {
        const renderer = new AuxiliaryBufferRenderer(observableDevice(device), layout);
        renderer.enable(64, 48, 8 * 1024 * 1024, true);
        try {
          const encoder = device.createCommandEncoder(),
            bindings = { media: media.bindings, generators: new Map() };
          if (item.prime) renderer.encodePlan(encoder, unpack(item.prime), vertices, bindings);
          renderer.encodePlan(encoder, candidate, vertices, bindings);
          device.queue.submit([encoder.finish()]);
          return await readAuxiliary(device, renderer, item.tier);
        } finally {
          renderer.destroy();
        }
      };
      const targets = await run(plan),
        mutations = [];
      const owned = readAuxiliaryPlan(plan);
      if (owned.slice.status === "drawn") {
        const changed = structuredClone(owned);
        changed.ids[0] ^= 0x00ffffff;
        mutations.push({
          id: "change-id",
          targets: await run(
            buildAuxiliaryPlan(changed.header, changed.slice, changed.ids, changed.motion),
          ),
        });
        const removed = structuredClone(owned);
        removed.slice.draws = removed.slice.draws.slice(1);
        removed.ids = removed.ids.slice(2);
        mutations.push({
          id: "remove-draw",
          targets: await run(
            buildAuxiliaryPlan(removed.header, removed.slice, removed.ids, removed.motion),
          ),
        });
        if (owned.motion) {
          const flipped = new Float32Array(owned.motion);
          flipped.fill(0);
          mutations.push({
            id: "remove-motion",
            targets: await run(buildAuxiliaryPlan(owned.header, owned.slice, owned.ids, flipped)),
          });
        }
        const texture = structuredClone(owned);
        texture.slice.draws[1].texture = { kind: "none" };
        mutations.push({
          id: "remove-texture",
          targets: await run(
            buildAuxiliaryPlan(texture.header, texture.slice, texture.ids, texture.motion),
          ),
        });
        if (item.tier >= 1) {
          const tier = structuredClone(owned);
          tier.slice.tier = 0;
          mutations.push({
            id: "remove-transparency",
            targets: await run(buildAuxiliaryPlan(tier.header, tier.slice, tier.ids, tier.motion)),
          });
        }
      } else if (item.prime)
        mutations.push({ id: "skip-clear", targets: await run(unpack(item.prime)) });
      results.push({ id: item.id, targets, mutations });
      vertices.destroy();
      media.destroy();
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    device.destroy();
  }
}
Object.assign(window, { captureAuxiliary: capture, replayAuxiliary: replay });
