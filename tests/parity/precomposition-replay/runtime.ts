import { capturePrecompositionBundle } from "../../../src/renderer/compositing/precomposition-bundle-capture";
import { omitUnavailableGenerators } from "../../../src/renderer/compositing/precomposition-generator-availability";
import {
  type PrecompositionBundle,
  PrecompositionSurfaceRenderer,
} from "../../../src/renderer/compositing/precomposition-surface-renderer";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { precompositionPlanResources } from "../../../src/renderer/frame-plan/precomposition-bundle-layout";
import { buildPrecompositionBundle } from "../../../src/renderer/frame-plan/precomposition-bundle-plan";
import { readPrecompositionBundle } from "../../../src/renderer/frame-plan/precomposition-bundle-read";
import { buildPrecompositionGraph } from "../../../src/renderer/frame-plan/precomposition-graph-plan";
import type { PutResource } from "../../../src/renderer/frame-plan/types";
import { createMediaPixelPayload } from "../../../src/renderer/media/media-pixel-payload";
import { MediaTextureCache } from "../../../src/renderer/media/media-texture-cache";
import { SuppliedMediaPixels } from "../../../src/renderer/media/supplied-media-pixels";
import { bundledParticleDefinition } from "../../../src/renderer/scene/bundled-particle-generator";
import { SceneGeneratorHost } from "../../../src/renderer/scene/scene-generator-host";
import { drawSurface, surfaceOptions } from "./draw";

type Packet = {
  plan_resources: string[];
  plan: number[];
  resources: { message: PutResource; bytes: number[] }[];
};
type Input = { id: string; output: string; bundle: Packet; warmup?: Packet }[];
const pack = (bundle: PrecompositionBundle): Packet => ({
  plan_resources:
    bundle.plan.metadata.slices[0].kind === "precomposition_bundle"
      ? precompositionPlanResources(bundle.plan.metadata.slices[0])
      : [],
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
    for (const id of ["direct", "nested", "effects", "generator", "generator-failed", "media"]) {
      console.info(`Capture ${id}: prepare`);
      const options = surfaceOptions(device);
      const Host = id === "generator-failed" ? UnavailableHost : SceneGeneratorHost;
      const legacyHost = new Host(device, "rgba16float", [bundledParticleDefinition]);
      const plannerHost = new Host(device, "rgba16float", [bundledParticleDefinition]);
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
      try {
        const f = surfaceFixture(id);
        legacyHost.beginFrame();
        plannerHost.beginFrame();
        legacy.prepare(f.project, f.scene, false);
        await mediaTextures.waitForFrameResources();
        const reference = await drawSurface(device, legacy, f.output, (encoder) =>
          legacy.encode(encoder),
        );
        console.info(`Capture ${id}: reference read back`);
        const frame = producer.prepare(f.project, f.scene, false);
        await mediaTextures.waitForFrameResources();
        const media = mediaTextures.acquireFrameBindings(
          [...frame.mediaInstanceIds],
          "precomposition-replay",
        );
        const supplied = producer.buildBundle(media);
        if (!supplied) throw Error("No captured bundle");
        const executed = producer.planScenes(media);
        const bundle = await capturePrecompositionBundle(device, supplied, media, executed);
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
        mediaTextures.abortFrame();
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
      ...(item.id === "media" ? ["change-media-pixels"] : []),
    ];
    const outputs = [];
    for (const mutation of ["none", ...mutations]) {
      console.info(`Replay ${item.id}: ${mutation}`);
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw Error("GPU unavailable");
      const device = await adapter.requestDevice();
      device.pushErrorScope("validation");
      const host = new SceneGeneratorHost(device, "rgba16float", []);
      const options = surfaceOptions(device);
      const renderer = new PrecompositionSurfaceRenderer(device, {
        ...options,
        sceneGenerators: host,
      });
      let media: SuppliedMediaPixels | undefined;
      try {
        host.beginFrame();
        let pinned: GPUBindGroup | undefined;
        if (item.warmup) {
          renderer.prepareBundle(unpack(item.warmup));
          pinned = renderer.bindingFor("warmup");
        }
        const bundle = unpack(item.bundle);
        if (mutation === "restore-generator") {
          const slice = bundle.plan.metadata.slices[0];
          if (slice.kind !== "precomposition_bundle") throw Error("Missing surface bundle");
          for (const scene of slice.scenes)
            for (const generator of scene.generators) generator.execution = { status: "planned" };
        }
        const decoded = readPrecompositionBundle(bundle.plan, bundle.resources);
        const captured = decoded.mediaPixels.map((capture) =>
          mutation === "change-media-pixels"
            ? createMediaPixelPayload(
                capture.frame,
                Uint8Array.from(capture.pixels.bytes, (v, i) => (i % 4 === 3 ? v : 255 - v)),
              )
            : capture,
        );
        media = new SuppliedMediaPixels(
          captured,
          decoded.plans.flatMap((plan) =>
            plan.draws.flatMap((draw) =>
              draw.texture.kind === "media" && draw.texture.hash !== null
                ? [draw.texture.hash]
                : [],
            ),
          ),
          {
            device,
            label: "Supplied child media",
            maximumDimension: device.limits.maxTextureDimension2D,
            maximumBytes: 64 * 1024 * 1024,
            createBindGroup: (texture) =>
              device.createBindGroup({
                layout: options.mediaLayout,
                entries: [
                  { binding: 0, resource: texture.createView() },
                  { binding: 1, resource: options.mediaSampler },
                ],
              }),
          },
        );
        const plans = renderer.prepareBundle(bundle);
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
        const bindings = media;
        const pixels = await drawSurface(device, renderer, item.output, (encoder) =>
          renderer.encode(encoder, plans, bindings),
        );
        const error = await device.popErrorScope();
        if (error) throw Error(error.message);
        outputs.push({ mutation, pixels, pinned: Boolean(pinned) });
      } finally {
        media?.destroy();
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
