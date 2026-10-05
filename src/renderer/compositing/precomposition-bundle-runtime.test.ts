import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { buildPrecompositionBundle } from "../frame-plan/precomposition-bundle-plan";
import { precompositionGraphFixtures } from "../frame-plan/precomposition-graph-fixture";
import {
  buildPrecompositionGraph,
  readPrecompositionGraph,
} from "../frame-plan/precomposition-graph-plan";
import { MediaBindingLease } from "../media/media-binding-lease";
import { MediaTextureCache } from "../media/media-texture-cache";
import type { SceneGeneratorHost } from "../scene/scene-generator-host";
import type { PrecompositionScenePlan } from "./precomposition-scene-plan";
import { PrecompositionSurfaceRenderer } from "./precomposition-surface-renderer";
import {
  blendPipelines,
  installGpuConstants,
  mockDevice,
  mockEncoder,
} from "./precomposition-test-gpu";

function runtime(host?: SceneGeneratorHost, source = false) {
  installGpuConstants();
  const textures: GPUTextureDescriptor[] = [];
  const destroy = vi.fn();
  const device = mockDevice(textures, destroy);
  const layout = device.createBindGroupLayout({ entries: [] });
  const renderer = new PrecompositionSurfaceRenderer(device, {
    mediaTextures: source
      ? new MediaTextureCache(device, layout, device.createSampler(), vi.fn())
      : undefined,
    mediaLayout: layout,
    mediaSampler: device.createSampler(),
    lightingLayout: layout,
    shapePipelines: blendPipelines(),
    imagePipelines: blendPipelines(),
    sceneGenerators: host,
  });
  return { renderer, device, textures, destroy };
}

function bundleFor(plans: PrecompositionScenePlan[]) {
  const graph = buildPrecompositionGraph(
    plans[0].scene.metadata.header,
    plans.map((p) => ({
      target: p.target,
      drawTargets: p.draws.map((d) =>
        d.texture.kind === "surface" ? d.texture.targetId : undefined,
      ),
    })),
    new Map(plans.map((p) => [p.target.id, p.target.id])),
  );
  return buildPrecompositionBundle(graph, plans, []);
}

function independentTargets(ids: string[]) {
  const leaf = precompositionGraphFixtures()[0].plans[0];
  return ids.map((id) => ({ ...structuredClone(leaf), target: { ...leaf.target, id } }));
}

describe("supplied precomposition bundle execution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("captures a production bundle before upload and consumes it after the source renderer is destroyed", () => {
    const producer = runtime(undefined, true);
    const consumer = runtime();
    const project = createBlankProject();
    const root = project.compositions[0];
    root.width = 64;
    root.height = 48;
    const child = { ...structuredClone(root), id: "source-child" };
    child.layers = [createLayerForComposition("shape", child)];
    project.compositions.push(child);
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = child.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    const scene = flattenSceneLayers(root, project, 0);
    const media = new MediaBindingLease([]);
    try {
      producer.renderer.prepare(project, scene, false);
      const bundle = producer.renderer.buildBundle(media);
      if (!bundle) throw new Error("Production did not capture a bundle");
      expect(producer.device.queue.writeBuffer).not.toHaveBeenCalled();
      producer.renderer.destroy();
      child.layers = [];
      const plans = consumer.renderer.prepareBundle(structuredClone(bundle));
      expect(consumer.renderer.bindingFor(scene[0].instanceId)).toBeDefined();
      const events: string[] = [];
      consumer.renderer.encode(mockEncoder(events), plans, media);
      expect(events.filter((e) => e === "draw")).toHaveLength(1);
      expect(consumer.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    } finally {
      media.release();
      consumer.renderer.destroy();
    }
  });

  it("allocates and executes child-first scenes on a fresh consumer without an authoring cache", () => {
    const fixture = precompositionGraphFixtures()[0];
    const bundle = structuredClone(buildPrecompositionBundle(fixture, fixture.plans, []));
    const { renderer, device } = runtime();
    const media = new MediaBindingLease([]);
    try {
      const plans = renderer.prepareBundle(bundle);
      const graph = readPrecompositionGraph(fixture);
      for (const alias of graph.bindings.keys()) expect(renderer.bindingFor(alias)).toBeDefined();
      expect(plans.map((p) => p.target.id)).toEqual(graph.nodes.map((n) => n.target.id));
      expect(device.queue.writeBuffer).toHaveBeenCalledTimes(4);
      expect(renderer.estimatedBytes).toBe(64 * 48 * 12 * 2);
      const events: string[] = [];
      renderer.encode(mockEncoder(events), plans, media);
      expect(events.filter((e) => e.startsWith("pass:Isolated precomposition"))).toHaveLength(2);
      expect(events.filter((e) => e === "draw")).toHaveLength(4);
      expect(renderer.bindingFor("root/a")).toBe(renderer.bindingFor("root/b"));
    } finally {
      media.release();
      renderer.destroy();
    }
  });

  it("pins all retained frame targets before allocating a new earlier target", () => {
    const { renderer, textures, destroy } = runtime();
    try {
      renderer.prepareBundle(bundleFor(independentTargets(["kept"])));
      const kept = renderer.bindingFor("kept");
      renderer.prepareBundle(bundleFor(independentTargets(["new", "kept"])));
      expect(renderer.bindingFor("kept")).toBe(kept);
      expect(renderer.bindingFor("new")).not.toBe(kept);
      expect(
        textures.filter((t) => t.label?.startsWith("Precomposition HDR surface")),
      ).toHaveLength(2);
      expect(destroy).not.toHaveBeenCalled();
      renderer.prepareBundle(bundleFor(independentTargets(["replacement"])));
      expect(
        textures.filter((t) => t.label?.startsWith("Precomposition HDR surface")),
      ).toHaveLength(2);
    } finally {
      renderer.destroy();
    }
  });

  it("rejects corrupt payloads and conflicting target identities before changing the live frame", () => {
    const { renderer, device } = runtime();
    try {
      const plans = independentTargets(["kept"]);
      const bundle = bundleFor(plans);
      renderer.prepareBundle(bundle);
      const kept = renderer.bindingFor("kept");
      vi.mocked(device.queue.writeBuffer).mockClear();
      vi.mocked(device.createTexture).mockClear();
      const corrupt = structuredClone(bundle);
      const payload = corrupt.resources.find((r) => r.bytes.length > 0);
      if (!payload) throw new Error("Fixture has no payload");
      payload.bytes[0] ^= 1;
      expect(() => renderer.prepareBundle(corrupt)).toThrow(/hash mismatch/);
      plans[0].target.hasEffects = true;
      plans[0].target.estimatedBytes = 64 * 48 * 38;
      plans[0].target.textureCount = 5;
      expect(() => renderer.prepareBundle(bundleFor(plans))).toThrow(/allocation descriptor/);
      expect(renderer.bindingFor("kept")).toBe(kept);
      expect(device.queue.writeBuffer).not.toHaveBeenCalled();
      expect(device.createTexture).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
    }
  });

  it("rejects unsupported target dimensions before any GPU allocation or upload", () => {
    const { renderer, device } = runtime();
    try {
      Object.assign(device.limits, { maxTextureDimension2D: 32 });
      vi.mocked(device.createTexture).mockClear();
      expect(() => renderer.prepareBundle(bundleFor(independentTargets(["large"])))).toThrow(
        /device or memory limits/,
      );
      expect(device.createTexture).not.toHaveBeenCalled();
      expect(device.queue.writeBuffer).not.toHaveBeenCalled();
    } finally {
      renderer.destroy();
    }
  });

  it("realizes supplied generators once and preserves explicit failures without compute or generator draws", () => {
    const host = {
      preparePlanned: vi.fn(() => undefined),
      encodeCompute: vi.fn(),
      encodeDraw: vi.fn(),
    };
    const { renderer } = runtime(host as unknown as SceneGeneratorHost);
    const fixture = precompositionGraphFixtures(true)[0];
    const media = new MediaBindingLease([]);
    try {
      const plans = renderer.prepareBundle(buildPrecompositionBundle(fixture, fixture.plans, []));
      expect(host.preparePlanned).toHaveBeenCalledTimes(1);
      const events: string[] = [];
      renderer.encode(mockEncoder(events), plans, media);
      expect(host.encodeCompute).not.toHaveBeenCalled();
      expect(host.encodeDraw).not.toHaveBeenCalled();
      expect(events.some((e) => e.startsWith("compute:"))).toBe(false);
      expect(events.filter((e) => e === "draw").length).toBeGreaterThan(0);
    } finally {
      media.release();
      renderer.destroy();
    }
  });
});
