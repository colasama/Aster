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
import { buildSceneLighting } from "../scene/scene-lighting";
import {
  executePrecompositionScene,
  type PrecompositionExecutionTarget,
} from "./execute-precomposition-scene";
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
  const plan = buildPrecompositionScenePlan({
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
  return { plan, composition, layers, geometry, lighting, effects, surfaces };
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
    mediaBinding: vi.fn(() => ({ name: "media" }) as unknown as GPUBindGroup),
    surfacePipelines: pipelines,
    imagePipelines: pipelines,
    shapePipelines: pipelines,
  };
  return { input, pass, passes };
}
describe("owned precomposition scene plans", () => {
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
    expect(e.input.mediaBinding).toHaveBeenCalledOnce();
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
