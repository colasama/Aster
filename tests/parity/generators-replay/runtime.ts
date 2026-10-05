import type { PluginStatus } from "../../../src/core/plugins/plugins";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import {
  buildGeneratorSlice,
  readGeneratorSlice,
} from "../../../src/renderer/frame-plan/generator-plan";
import { buildFrameHeader } from "../../../src/renderer/frame-plan/root-post-plan";
import type { PutResource } from "../../../src/renderer/frame-plan/types";
import { bundledParticleDefinition } from "../../../src/renderer/scene/bundled-particle-generator";
import { SceneGeneratorHost } from "../../../src/renderer/scene/scene-generator-host";
import type { SceneGeneratorPlan } from "../../../src/renderer/scene/scene-generator-plan";
import { drawGenerators } from "./draw";
import { SceneGeneratorHost as LegacyHost } from "./legacy-host";

async function capture(status: PluginStatus) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const legacy = new LegacyHost(device, "rgba16float", [bundledParticleDefinition]);
  const planner = new SceneGeneratorHost(device, "rgba16float", [bundledParticleDefinition]);
  try {
    const { generatorCases } = await import("./fixtures");
    const cases = [],
      resources = new Map<string, { message: PutResource; bytes: number[] }>();
    for (const f of generatorCases(status)) {
      legacy.beginFrame(() => f.audio);
      planner.beginFrame(() => f.audio);
      const prepared = f.scenes.map((scene) => {
        const p = legacy.prepare(scene, f.composition, 128, 96, 32);
        if (!p) throw Error(legacy.diagnostics.join("\n"));
        return p;
      });
      const plans = f.scenes.map((scene) => {
        const p = planner.plan(scene, f.composition, 128, 96, 32);
        if (!p) throw Error(planner.diagnostics.join("\n"));
        const header = buildFrameHeader({
          snapshot: { snapshotScope: "generator-replay", projectRevision: 1 },
          compositionId: f.composition.id,
          time: 1.5,
          frameRate: f.composition.frameRate,
          target: { width: 320, height: 240 },
          renderTarget: { width: 128, height: 96 },
          antiAliasing: "off",
        });
        const plan = buildGeneratorSlice(header, p);
        for (const r of p.program.shaders)
          resources.set(r.message.hash, { message: r.message, bytes: Array.from(r.bytes) });
        return Array.from(encodeFramePlan(plan.metadata, plan.blobs));
      });
      const reference = await drawGenerators(
        device,
        (pass) =>
          prepared.forEach((p) => {
            legacy.encodeCompute(pass, p);
          }),
        (pass) =>
          prepared.forEach((p) => {
            legacy.draw(pass, p);
          }),
      );
      cases.push({
        id: f.id,
        plans,
        reference,
        counts: prepared.map((p) => p.effectiveCount),
        rootTime: f.rootTime,
      });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return {
      cases,
      resources: Array.from(resources.values()),
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
  cases: { id: string; plans: number[][] }[];
  resources: { message: PutResource; bytes: number[] }[];
};
async function replay(input: Input) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const host = new SceneGeneratorHost(device, "rgba16float");
  try {
    const resources = new Map(
      input.resources.map((r) => {
        if (r.message.kind !== "buffer") throw Error("Expected shader buffer");
        return [r.message.hash, { message: r.message, bytes: new Uint8Array(r.bytes) }] as const;
      }),
    );
    const run = (plans: SceneGeneratorPlan[], compute = true) => {
      host.beginFrame();
      const prepared = plans.map((p) => host.preparePlan(p));
      return drawGenerators(
        device,
        (pass) => {
          if (compute)
            prepared.forEach((p) => {
              host.encodeCompute(pass, p);
            });
        },
        (pass) =>
          prepared.forEach((p) => {
            host.draw(pass, p);
          }),
      );
    };
    const results = [];
    for (const f of input.cases) {
      const plans = f.plans.map((p) =>
        readGeneratorSlice(decodeFramePlan(new Uint8Array(p)), resources),
      );
      const pixels = await run(plans);
      const mutations = [{ id: "skip-compute", pixels: await run(plans, false) }];
      const changed = structuredClone(plans);
      for (const p of changed) {
        if (p.audio) p.audio.fill(0, 32);
        else
          new Float32Array(p.context.buffer, p.context.byteOffset, p.context.byteLength / 4)[11] =
            0;
      }
      mutations.push({
        id: f.id.startsWith("audio-") ? "silent-audio" : "zero-opacity",
        pixels: await run(changed),
      });
      if (f.id === "clones")
        mutations.push({ id: "remove-clone", pixels: await run(plans.slice(1)) });
      results.push({ id: f.id, pixels, counts: plans.map((p) => p.effectiveCount), mutations });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    host.destroy();
    device.destroy();
  }
}
Object.assign(window, { captureGenerators: capture, replayGenerators: replay });
