import { omitUnavailableGenerators } from "../../../src/renderer/compositing/precomposition-generator-availability";
import {
  type PrecompositionBundle,
  PrecompositionSurfaceRenderer,
} from "../../../src/renderer/compositing/precomposition-surface-renderer";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { buildPrecompositionBundle } from "../../../src/renderer/frame-plan/precomposition-bundle-plan";
import { readPrecompositionBundle } from "../../../src/renderer/frame-plan/precomposition-bundle-read";
import { buildPrecompositionGraph } from "../../../src/renderer/frame-plan/precomposition-graph-plan";
import type { PutResource } from "../../../src/renderer/frame-plan/types";
import { MediaBindingLease } from "../../../src/renderer/media/media-binding-lease";
import { MediaTextureCache } from "../../../src/renderer/media/media-texture-cache";
import { bundledParticleDefinition } from "../../../src/renderer/scene/bundled-particle-generator";
import { SceneGeneratorHost } from "../../../src/renderer/scene/scene-generator-host";
import { drawSurface, surfaceOptions } from "./draw";

type Packet = { plan: number[]; resources: { message: PutResource; bytes: number[] }[] };
type Input = { id: string; output: string; bundle: Packet; warmup?: Packet }[];
const pack = (bundle: PrecompositionBundle): Packet => ({
  plan: Array.from(encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
  resources: bundle.resources.map((r) => ({ message: r.message, bytes: Array.from(r.bytes) })),
});
const unpack = (packet: Packet): PrecompositionBundle => ({
  plan: decodeFramePlan(new Uint8Array(packet.plan)),
  resources: packet.resources.map((r) => ({ message: r.message, bytes: new Uint8Array(r.bytes) })),
});
class UnavailableHost extends SceneGeneratorHost {
  override preparePlan(): never {
    throw Error("Injected generator allocation failure");
  }
}
async function capture() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const { surfaceFixture } = await import("./fixtures");
  const { PrecompositionSurfaceRenderer: Legacy } = await import("./legacy-surface");
  const cases = [];
  try {
    for (const id of ["direct", "nested", "effects", "generator", "generator-failed"]) {
      console.info(`Capture ${id}: prepare`);
      const options = surfaceOptions(device);
      const Host = id === "generator-failed" ? UnavailableHost : SceneGeneratorHost;
      const legacyHost = new Host(device, "rgba16float", [bundledParticleDefinition]);
      const plannerHost = new SceneGeneratorHost(device, "rgba16float", [
        bundledParticleDefinition,
      ]);
      const mediaTextures = new MediaTextureCache(
        device,
        options.mediaLayout,
        options.mediaSampler,
        () => {},
      );
      const legacy = new Legacy(device, { ...options, mediaTextures, sceneGenerators: legacyHost });
      const producer = new PrecompositionSurfaceRenderer(device, {
        ...options,
        mediaTextures,
        sceneGenerators: plannerHost,
      });
      const media = new MediaBindingLease([]);
      try {
        const f = surfaceFixture(id);
        legacyHost.beginFrame();
        plannerHost.beginFrame();
        legacy.prepare(f.project, f.scene, false);
        const reference = await drawSurface(device, legacy, f.output, (encoder) =>
          legacy.encode(encoder),
        );
        console.info(`Capture ${id}: reference read back`);
        producer.prepare(f.project, f.scene, false);
        const bundle = producer.buildBundle(media);
        if (!bundle) throw Error("No captured bundle");
        const decoded = readPrecompositionBundle(bundle.plan, bundle.resources);
        let warmup: Packet | undefined;
        if (id === "nested") {
          const leaf = structuredClone(decoded.plans[0]);
          leaf.target = { ...decoded.plans[1].target };
          const graph = buildPrecompositionGraph(
            leaf.scene.metadata.header,
            [{ target: leaf.target, drawTargets: leaf.draws.map(() => undefined) }],
            new Map([["warmup", leaf.target.id]]),
          );
          warmup = pack(buildPrecompositionBundle(graph, [leaf], []));
        }
        cases.push({
          id,
          output: f.output,
          bundle: pack(bundle),
          warmup,
          reference,
          scenes: decoded.plans.length,
          generators: decoded.plans.reduce((n, p) => n + p.generators.length, 0),
        });
      } finally {
        media.release();
        legacy.destroy();
        producer.destroy();
        legacyHost.destroy();
        plannerHost.destroy();
        mediaTextures.destroy();
      }
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
async function replay(input: Input) {
  const results = [];
  for (const item of input) {
    const mutations = [
      "remove-draw",
      ...(item.id === "nested" ? ["reverse-order"] : []),
      ...(item.id === "effects" ? ["remove-adjustment"] : []),
      ...(item.id === "generator" ? ["remove-generator"] : []),
      ...(item.id === "generator-failed" ? ["restore-generator"] : []),
    ];
    const outputs = [];
    for (const mutation of ["none", ...mutations]) {
      console.info(`Replay ${item.id}: ${mutation}`);
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw Error("GPU unavailable");
      const device = await adapter.requestDevice();
      device.pushErrorScope("validation");
      const Host =
        item.id === "generator-failed" && mutation !== "restore-generator"
          ? UnavailableHost
          : SceneGeneratorHost;
      const host = new Host(device, "rgba16float", []);
      const renderer = new PrecompositionSurfaceRenderer(device, {
        ...surfaceOptions(device),
        sceneGenerators: host,
      });
      const media = new MediaBindingLease([]);
      try {
        host.beginFrame();
        let pinned: GPUBindGroup | undefined;
        if (item.warmup) {
          renderer.prepareBundle(unpack(item.warmup));
          pinned = renderer.bindingFor("warmup");
        }
        const plans = renderer.prepareBundle(unpack(item.bundle));
        if (item.warmup && (!pinned || pinned !== renderer.bindingFor(item.output)))
          throw Error("Current frame target was recycled");
        if (mutation === "remove-draw") {
          const index = plans[0].commands.findIndex((c) => c.kind === "geometry");
          if (index < 0) throw Error("No geometry to perturb");
          plans[0].commands.splice(index, 1);
        }
        if (mutation === "reverse-order") plans.reverse();
        if (mutation === "remove-adjustment")
          for (const plan of plans)
            plan.commands = plan.commands.filter((c) => c.kind !== "adjustment");
        if (mutation === "remove-generator")
          for (const plan of plans)
            plan.commands = [
              ...omitUnavailableGenerators(
                plan.commands,
                new Set(plan.generators.map((g) => g.instanceId)),
              ),
            ];
        const pixels = await drawSurface(device, renderer, item.output, (encoder) =>
          renderer.encode(encoder, plans, media),
        );
        const error = await device.popErrorScope();
        if (error) throw Error(error.message);
        outputs.push({ mutation, pixels, pinned: Boolean(pinned) });
      } finally {
        media.release();
        renderer.destroy();
        host.destroy();
        device.destroy();
      }
    }
    results.push({ id: item.id, outputs });
  }
  return results;
}
Object.assign(window, { capturePrecompositions: capture, replayPrecompositions: replay });
