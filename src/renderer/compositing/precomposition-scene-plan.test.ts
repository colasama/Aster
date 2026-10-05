import { describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { BLEND_MODES, type BlendMode } from "../../core/types";
import { prepareLayerEffects } from "../effects/layer-effect-plan";
import { decodeFramePlan, encodeFramePlan } from "../frame-plan/codec";
import { buildFrameHeader } from "../frame-plan/root-post-plan";
import { prepareSceneBuffers } from "../frame-plan/scene-buffer-upload";
import { buildSceneGeometry } from "../geometry/geometry";
import { LutSelectionPlanner } from "../media/lut-selection-plan";
import { MediaBindingLease } from "../media/media-binding-lease";
import { destroyMediaResource, type MediaResource } from "../media/media-resource";
import { buildSceneLighting } from "../scene/scene-lighting";
import {
  executePrecompositionScene,
  type PrecompositionExecutionTarget,
} from "./execute-precomposition-scene";
import { bindPrecompositionSceneMedia } from "./precomposition-scene-media";
import { buildPrecompositionScenePlan } from "./precomposition-scene-plan";

function fixture() {
  const project = createBlankProject(),
    composition = project.compositions[0];
  composition.width = 64;
  composition.height = 48;
  composition.background = [0.1, 0.2, 0.3, 0.5];
  const child = structuredClone(composition);
  child.id = "child";
  project.compositions.push(child);
  const shape = createLayerForComposition("shape", composition);
  const wrapper = createLayerForComposition("precomposition", composition);
  wrapper.sourceCompositionId = child.id;
  wrapper.threeDimensional = true;
  const image = createLayerForComposition("image", composition);
  composition.layers = [image, shape, wrapper];
  const layers = flattenSceneLayers(composition, project, 2);
  const geometry = buildSceneGeometry(composition, layers);
  const lighting = buildSceneLighting(layers, composition, false);
  const header = buildFrameHeader({
    snapshot: { snapshotScope: "test", projectRevision: 1 },
    compositionId: composition.id,
    time: 2,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
  });
  const effects = new Map(
    prepareLayerEffects({
      scene: layers,
      composition,
      header,
      context: "precomposition",
      mipLevelCount: 1,
      planner: new LutSelectionPlanner(),
    }),
  );
  const surfaces = new Map(
    layers.filter((s) => s.precompositionSurface).map((s) => [s.instanceId, "child-target"]),
  );
  const inputs = buildPrecompositionScenePlan({
    target: {
      id: "parent",
      width: 64,
      height: 48,
      estimatedBytes: 64 * 48 * 12,
      textureCount: 2,
      hasEffects: false,
    },
    revision: 1,
    composition,
    time: 2,
    layers,
    geometry,
    lighting,
    effects,
    generators: [],
    surfaceTargets: surfaces,
  });
  const plan = bindPrecompositionSceneMedia(inputs, {
    hashFor: () => "a".repeat(64),
    bindingForHash: () => ({}) as GPUBindGroup,
  });
  return { plan, inputs, composition, layers, geometry, lighting, effects, surfaces };
}
function executor(plan: ReturnType<typeof fixture>["plan"]) {
  const passes: GPURenderPassDescriptor[] = [];
  const pass = {
    setVertexBuffer: vi.fn(),
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  } as unknown as GPURenderPassEncoder;
  const encoder = {
    beginRenderPass: (d: GPURenderPassDescriptor) => {
      passes.push(d);
      return pass;
    },
  } as unknown as GPUCommandEncoder;
  const target = {
    color: { createView: () => ({}) },
    depth: { createView: () => ({}) },
    bindGroup: { name: "child" },
    vertexBuffer: {},
    lightingBindGroup: { name: "light" },
  } as unknown as PrecompositionExecutionTarget;
  const pipelines = Object.fromEntries(BLEND_MODES.map((m) => [m, {}])) as Record<
    BlendMode,
    GPURenderPipeline
  >;
  const input = {
    plan,
    encoder,
    targets: new Map([
      ["parent", target],
      ["child-target", target],
    ]),
    generators: new Map(),
    media: { bindingForHash: vi.fn(() => ({ name: "media" }) as unknown as GPUBindGroup) },
    surfacePipelines: pipelines,
    imagePipelines: pipelines,
    shapePipelines: pipelines,
  };
  return { input, pass, passes };
}
describe("owned precomposition scene plans", () => {
  it("replays supplied media hashes while retaining a retired texture until submission releases it", () => {
    const f = fixture();
    const mediaDraw = f.inputs.draws.find((d) => d.texture.kind === "media");
    if (mediaDraw?.texture.kind !== "media") throw new Error("Missing media fixture");
    const destroy = vi.fn();
    const resource: MediaResource = {
      source: "child-image",
      kind: "image",
      textureWidth: 16,
      textureHeight: 16,
      texture: { destroy } as unknown as GPUTexture,
      bindGroup: { name: "retained child texture" } as unknown as GPUBindGroup,
      mediaIdentity: {
        source: { source_id: "child", content_identity: "original-pixels", media_kind: "image" },
        sample: { kind: "image" },
      },
    };
    const lease = new MediaBindingLease(
      [{ instanceId: mediaDraw.texture.instanceId, resource, binding: resource.bindGroup }],
      "precomposition-test",
    );
    try {
      const plan = structuredClone(bindPrecompositionSceneMedia(f.inputs, lease));
      plan.scene = decodeFramePlan(encodeFramePlan(plan.scene.metadata, plan.scene.blobs));
      const hash = lease.hashFor(mediaDraw.texture.instanceId);
      expect(plan.scene.metadata.resources).toEqual([hash]);
      expect(plan.draws.find((d) => d.texture.kind === "media")?.texture).toEqual({
        kind: "media",
        hash,
      });
      expect(lease.resourceMessages).toHaveLength(2);
      destroyMediaResource(resource);
      expect(destroy).not.toHaveBeenCalled();
      const e = executor(plan);
      executePrecompositionScene({ ...e.input, media: lease });
      expect(e.pass.setBindGroup).toHaveBeenCalledWith(0, resource.bindGroup);
      expect(e.pass.draw).toHaveBeenCalledTimes(3);
    } finally {
      lease.release();
    }
    expect(destroy).toHaveBeenCalledOnce();
    const e = executor(
      bindPrecompositionSceneMedia(f.inputs, {
        hashFor: () => "a".repeat(64),
        bindingForHash: () => ({}) as GPUBindGroup,
      }),
    );
    expect(() => executePrecompositionScene({ ...e.input, media: lease })).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    expect(e.passes).toEqual([]);
  });

  it("rejects absent or inconsistent media before GPU recording and preserves explicit pending draws", () => {
    for (const mismatch of [false, true]) {
      const f = fixture();
      const e = executor(f.plan);
      if (mismatch) {
        const draw = f.plan.draws.find((d) => d.texture.kind === "media");
        if (draw?.texture.kind === "media") draw.texture.hash = "b".repeat(64);
      } else e.input.media.bindingForHash.mockReturnValue(undefined as unknown as GPUBindGroup);
      expect(() => executePrecompositionScene(e.input)).toThrow(
        expect.objectContaining({ code: "missing_resource" }),
      );
      expect(e.passes).toEqual([]);
    }
    const pending = bindPrecompositionSceneMedia(fixture().inputs, {
      hashFor: () => null,
      bindingForHash: () => {
        throw new Error("Pending media must not resolve a texture");
      },
    });
    const e = executor(pending);
    executePrecompositionScene(e.input);
    expect(e.input.media.bindingForHash).not.toHaveBeenCalled();
    expect(e.pass.draw).toHaveBeenCalledTimes(3);
    expect(pending.scene.metadata.resources).toEqual([]);
  });

  it("detaches authoring, byte uploads and target routing before encoding", () => {
    const f = fixture(),
      snapshot = structuredClone(f.plan);
    const originalVertices = new Uint8Array(f.geometry.data.buffer).slice(),
      originalLighting = new Uint8Array(f.lighting.buffer).slice();
    f.composition.background[0] = 0.9;
    f.composition.layers.reverse();
    f.layers.forEach((s) => {
      s.layer.blendMode = "multiply";
      s.layer.kind = "solid";
    });
    f.geometry.data.fill(0);
    f.lighting.fill(0);
    f.effects.clear();
    f.surfaces.clear();
    expect(f.plan).toEqual(snapshot);
    const decoded = decodeFramePlan(encodeFramePlan(f.plan.scene.metadata, f.plan.scene.blobs));
    expect(prepareSceneBuffers(decoded).vertices).toEqual(originalVertices);
    expect(prepareSceneBuffers(decoded).lighting).toEqual(originalLighting);
    const e = executor(structuredClone(f.plan));
    executePrecompositionScene(e.input);
    expect(e.pass.draw).toHaveBeenCalledTimes(3);
    expect(e.input.media.bindingForHash).toHaveBeenCalledOnce();
    expect(e.passes[0].colorAttachments[Symbol.iterator]().next().value?.clearValue).toEqual({
      r: 0.1,
      g: 0.2,
      b: 0.3,
      a: 0.5,
    });
    const changed = structuredClone(f.plan);
    changed.commands = changed.commands.filter((c) => c.kind !== "geometry" || c.drawIndex !== 0);
    const modified = executor(changed);
    executePrecompositionScene(modified.input);
    expect(modified.pass.draw).toHaveBeenCalledTimes(2);
  });
  it("rejects absent output or referenced child targets before recording GPU passes", () => {
    for (const missing of ["parent", "child-target"]) {
      const e = executor(fixture().plan);
      e.input.targets.delete(missing);
      expect(() => executePrecompositionScene(e.input)).toThrow(
        expect.objectContaining({ code: "missing_resource" }),
      );
      expect(e.passes).toEqual([]);
    }
  });
});
