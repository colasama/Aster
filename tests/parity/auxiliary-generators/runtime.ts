import type { PluginStatus } from "../../../src/core/plugins/plugins";
import {
  buildAuxiliaryPlan,
  readAuxiliaryPlan,
} from "../../../src/renderer/frame-plan/auxiliary-plan";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { compositionIdentityFromString } from "../../../src/renderer/frame-plan/composition-identity";
import {
  buildGeneratorSlice,
  readGeneratorSlice,
} from "../../../src/renderer/frame-plan/generator-plan";
import { buildFrameHeader } from "../../../src/renderer/frame-plan/root-post-plan";
import type { FramePlanSliceData, PutResource } from "../../../src/renderer/frame-plan/types";
import { AuxiliaryBufferRenderer } from "../../../src/renderer/gpu/auxiliary-buffer-renderer";
import { bundledParticleDefinition } from "../../../src/renderer/scene/bundled-particle-generator";
import { SceneGeneratorHost } from "../../../src/renderer/scene/scene-generator-host";
import type { SceneGeneratorPlan } from "../../../src/renderer/scene/scene-generator-plan";
import { imageLayout, readAuxiliary } from "../auxiliary-replay/draw";
import { LegacyAuxiliaryBufferRenderer } from "../auxiliary-replay/legacy-auxiliary";
import { generatorCases } from "../generators-replay/fixtures";
import { SceneGeneratorHost as LegacyHost } from "../generators-replay/legacy-host";

const pack = (plan: FramePlanSliceData) => Array.from(encodeFramePlan(plan.metadata, plan.blobs));
async function gpu() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice({
    requiredLimits: { maxColorAttachments: 5, maxColorAttachmentBytesPerSample: 28 },
  });
  device.pushErrorScope("validation");
  return { device, adapter };
}
async function capture(status: PluginStatus) {
  const { device, adapter } = await gpu(),
    legacy = new LegacyHost(device, "rgba16float", [bundledParticleDefinition]),
    planner = new SceneGeneratorHost(device, "rgba16float", [bundledParticleDefinition]);
  const cases = [],
    resources = new Map<string, { message: PutResource; bytes: number[] }>();
  try {
    for (const fixture of generatorCases(status).filter((f) =>
      ["billboard", "streak", "mesh", "clones", "audio-bars"].includes(f.id),
    )) {
      legacy.beginFrame(() => fixture.audio);
      planner.beginFrame(() => fixture.audio);
      const prepared = fixture.scenes.map((scene) => {
        const p = legacy.prepare(scene, fixture.composition, 128, 96, 32);
        if (!p) throw Error(legacy.diagnostics.join("\n"));
        return p;
      });
      const header = buildFrameHeader({
        snapshot: { snapshotScope: "auxiliary-generators", projectRevision: 1 },
        compositionId: fixture.composition.id,
        time: 1.5,
        frameRate: fixture.composition.frameRate,
        target: { width: 320, height: 240 },
        renderTarget: { width: 128, height: 96 },
        antiAliasing: "off",
      });
      const planned = fixture.scenes.map((scene) => {
        const p = planner.plan(scene, fixture.composition, 128, 96, 32);
        if (!p) throw Error(planner.diagnostics.join("\n"));
        for (const r of p.program.shaders)
          resources.set(r.message.hash, { message: r.message, bytes: Array.from(r.bytes) });
        return p;
      });
      const layout = imageLayout(device),
        oldAux = new LegacyAuxiliaryBufferRenderer(device, layout),
        aux = new AuxiliaryBufferRenderer(device, layout);
      if (!oldAux.enable(128, 96, 8 * 1024 * 1024) || !aux.enable(128, 96, 8 * 1024 * 1024))
        throw Error("Auxiliary targets unavailable");
      const supplied = planned.map((p) => planner.preparePlan(p));
      const captured = aux.buildPlan({
        header,
        vertexCount: 0,
        batches: [],
        mediaBinding: () => undefined,
        generators: supplied.flatMap((p) => {
          const draw = planner.auxiliaryDraw(p);
          return draw ? [{ instanceId: p.instanceId, draw }] : [];
        }),
      });
      const vertices = device.createBuffer({ size: 160, usage: GPUBufferUsage.VERTEX }),
        encoder = device.createCommandEncoder(),
        compute = encoder.beginComputePass();
      for (const p of prepared) legacy.encodeCompute(compute, p);
      compute.end();
      oldAux.encode({
        encoder,
        vertexBuffer: vertices,
        vertexCount: 0,
        batches: [],
        mediaBindGroup: () => undefined,
        generators: prepared.map((p) => legacy.auxiliaryDraw(p)).filter((p) => p !== undefined),
      });
      device.queue.submit([encoder.finish()]);
      cases.push({
        id: fixture.id,
        plans: planned.map((p) => pack(buildGeneratorSlice(header, p))),
        auxiliary: pack(captured.plan),
        reference: await readAuxiliary(device, oldAux, -1, 128, 96),
        counts: prepared.map((p) => p.effectiveCount),
        auxiliary_count: readAuxiliaryPlan(captured.plan).slice.generators.length,
      });
      vertices.destroy();
      oldAux.destroy();
      aux.destroy();
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return {
      cases,
      resources: [...resources.values()],
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
    };
  } finally {
    legacy.destroy();
    planner.destroy();
    device.destroy();
  }
}
type Input = {
  cases: { id: string; plans: number[][]; auxiliary: number[] }[];
  resources: { message: PutResource; bytes: number[] }[];
};
async function replay(input: Input) {
  const { device } = await gpu();
  try {
    const resources = new Map(
      input.resources.map((r) => {
        if (r.message.kind !== "buffer") throw Error("Expected shader resource");
        return [r.message.hash, { message: r.message, bytes: new Uint8Array(r.bytes) }] as const;
      }),
    );
    const run = async (
      plans: SceneGeneratorPlan[],
      auxiliary: FramePlanSliceData,
      computeEnabled = true,
    ) => {
      const host = new SceneGeneratorHost(device, "rgba16float"),
        renderer = new AuxiliaryBufferRenderer(device, imageLayout(device)),
        vertices = device.createBuffer({ size: 160, usage: GPUBufferUsage.VERTEX });
      try {
        host.beginFrame();
        const prepared = plans.map((p) => host.preparePlan(p));
        renderer.enable(128, 96, 8 * 1024 * 1024);
        const generators = new Map(
          prepared.flatMap((p) => {
            const draw = host.auxiliaryDraw(p);
            return draw ? [[p.instanceId, draw] as const] : [];
          }),
        );
        const encoder = device.createCommandEncoder(),
          compute = encoder.beginComputePass();
        if (computeEnabled) for (const p of prepared) host.encodeCompute(compute, p);
        compute.end();
        renderer.encodePlan(encoder, auxiliary, vertices, { media: new Map(), generators });
        device.queue.submit([encoder.finish()]);
        return await readAuxiliary(device, renderer, -1, 128, 96);
      } finally {
        vertices.destroy();
        renderer.destroy();
        host.destroy();
      }
    };
    const results = [];
    for (const item of input.cases) {
      const plans = item.plans.map((p) =>
          readGeneratorSlice(decodeFramePlan(new Uint8Array(p)), resources),
        ),
        auxiliary = decodeFramePlan(new Uint8Array(item.auxiliary));
      const targets = await run(plans, auxiliary),
        mutations = [];
      let missingAuxiliaryRejected = false;
      const owned = readAuxiliaryPlan(auxiliary);
      if (owned.slice.generators.length) {
        mutations.push({ id: "skip-compute", targets: await run(plans, auxiliary, false) });
        const noDraw = structuredClone(owned);
        noDraw.slice.generators.shift();
        mutations.push({
          id: "remove-generator",
          targets: await run(
            plans,
            buildAuxiliaryPlan(noDraw.header, noDraw.slice, noDraw.ids, noDraw.motion),
          ),
        });
        const changedIds = structuredClone(plans);
        for (const p of changedIds)
          new DataView(p.context.buffer, p.context.byteOffset, p.context.byteLength).setUint32(
            144,
            0x12345678,
            true,
          );
        mutations.push({ id: "change-ids", targets: await run(changedIds, auxiliary) });
      } else {
        const invalid = buildAuxiliaryPlan(
          owned.header,
          {
            ...owned.slice,
            generators: plans.map((p) => compositionIdentityFromString(p.instanceId)),
          },
          owned.ids,
          owned.motion,
        );
        try {
          await run(plans, invalid);
        } catch (error) {
          if ((error as { code?: string }).code !== "missing_resource") throw error;
          missingAuxiliaryRejected = true;
        }
        if (!missingAuxiliaryRejected) throw Error("Unsupported auxiliary generator was accepted");
      }
      results.push({
        id: item.id,
        targets,
        mutations,
        missing_auxiliary_rejected: missingAuxiliaryRejected,
        counts: plans.map((p) => p.effectiveCount),
      });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    device.destroy();
  }
}
Object.assign(window, { captureAuxiliaryGenerators: capture, replayAuxiliaryGenerators: replay });
