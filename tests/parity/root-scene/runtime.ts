import { executeRootScene } from "../../../src/renderer/compositing/execute-root-scene";
import type { PreparedLayerEffect } from "../../../src/renderer/effects/layer-effect-plan";
import { LayerEffectRenderer } from "../../../src/renderer/effects/layer-effects";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { readLayerEffectSlice } from "../../../src/renderer/frame-plan/layer-effect-plan";
import { readRootScenePlan } from "../../../src/renderer/frame-plan/root-scene-plan";
import { prepareSceneBuffers } from "../../../src/renderer/frame-plan/scene-buffer-upload";
import type { FramePlanSliceData, PutResource } from "../../../src/renderer/frame-plan/types";
import { suppliedLutResource } from "../../../src/renderer/media/lut-selection-plan";
import type { MediaBindingLease } from "../../../src/renderer/media/media-binding-lease";
import { drawRoot } from "./draw";
import { legacyExecute } from "./legacy-execute";

const mediaBindings = {
  bindingForHash: () => {
    throw Error("Unexpected media dependency");
  },
} as unknown as MediaBindingLease;
const bytes = (plan: FramePlanSliceData) => Array.from(encodeFramePlan(plan.metadata, plan.blobs));
type ReplayCase = {
  id: string;
  scene: number[];
  root: number[];
  effects: { id: string; plan: number[]; execution: number[] }[];
};
type Input = { cases: ReplayCase[]; resources: { message: PutResource; bytes: number[] }[] };
async function capture() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const effects = new LayerEffectRenderer(device, "rgba16float");
  effects.resize(64, 48);
  try {
    const { rootFixture } = await import("./fixtures");
    const cases = [];
    const resources = new Map<string, { message: PutResource; bytes: number[] }>();
    for (const id of ["direct", "depth", "isolated", "adjustment"]) {
      const f = rootFixture(id, effects);
      const result = await drawRoot(device, f.buffers, effects, (input) =>
        legacyExecute({
          ...input,
          composition: f.composition,
          renderStack: f.stack,
          effectPlans: f.effects,
          generatorByInstance: new Map(),
          mediaBindings,
        }),
      );
      const compiled = [];
      for (const [key, e] of f.effects)
        if (e.status === "ready") {
          const r = suppliedLutResource(e.lut);
          resources.set(r.message.hash, { message: r.message, bytes: Array.from(r.bytes) });
          compiled.push({ id: key, plan: bytes(e.plan), execution: bytes(e.execution) });
        }
      cases.push({
        id,
        scene: bytes(f.scenePlan),
        root: bytes(f.rootPlan),
        effects: compiled,
        reference: result.pixels,
        metrics: result.metrics,
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
    effects.destroy();
    device.destroy();
  }
}
async function replay(input: Input) {
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
        { message: r.message, bytes: new Uint8Array(r.bytes), label: "Supplied root LUT" },
      ]),
    );
    const results = [];
    for (const item of input.cases) {
      const buffers = prepareSceneBuffers(decodeFramePlan(new Uint8Array(item.scene)));
      const root = readRootScenePlan(decodeFramePlan(new Uint8Array(item.root)));
      const effects = new Map<string, PreparedLayerEffect>();
      for (const e of item.effects) {
        const plan = decodeFramePlan(new Uint8Array(e.plan));
        const compiled = readLayerEffectSlice(plan);
        const r = resources.get(compiled.slice.lut_hash);
        if (r?.message.kind !== "texture_pixels") throw Error("Missing supplied LUT");
        effects.set(e.id, {
          status: "ready",
          plan,
          execution: decodeFramePlan(new Uint8Array(e.execution)),
          lut: { status: "ready", resource: { ...r, message: r.message } },
        });
      }
      const run = (commands: typeof root.commands) =>
        drawRoot(device, buffers, consumer, (context) =>
          executeRootScene({
            ...context,
            commands,
            draws: root.draws,
            effects,
            generators: new Map(),
            mediaBindings,
          }),
        );
      const result = await run(root.commands);
      const mutations: { id: string; pixels: number[] }[] = [];
      const last = root.commands.map((c) => c.kind).lastIndexOf("geometry");
      if (last < 0) throw Error("Missing visible draw");
      mutations.push({
        id: "remove-draw",
        pixels: (await run(root.commands.filter((_, i) => i !== last))).pixels,
      });
      if (item.id === "direct") {
        const changed = structuredClone(root.commands);
        const indices = changed.flatMap((c, i) => (c.kind === "geometry" ? [i] : []));
        [changed[indices[0]], changed[indices[2]]] = [changed[indices[2]], changed[indices[0]]];
        mutations.push({ id: "reorder-draws", pixels: (await run(changed)).pixels });
      }
      if (item.id === "depth") {
        const changed = structuredClone(root.commands);
        const pass = changed.find(
          (c) =>
            c.kind === "begin_scene" && c.group !== "composition" && c.depth.loadOp === "clear",
        );
        if (pass?.kind !== "begin_scene") throw Error("Missing depth transition");
        pass.depth.loadOp = "load";
        mutations.push({ id: "retain-depth", pixels: (await run(changed)).pixels });
      }
      if (item.id === "adjustment")
        mutations.push({
          id: "remove-adjustment",
          pixels: (await run(root.commands.filter((c) => c.kind !== "adjustment"))).pixels,
        });
      results.push({ id: item.id, ...result, mutations });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    consumer.destroy();
    device.destroy();
  }
}
Object.assign(window, { captureRootScenes: capture, replayRootScenes: replay });
