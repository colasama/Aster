import { createBlankComposition } from "../../core/project/project";
import { executeRootScene } from "../compositing/execute-root-scene";
import type { RootSceneCommand } from "../compositing/root-scene-commands";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import type { SceneDrawPlan } from "../scene/scene-draw-plan";
import type { PreparedSceneGenerator } from "../scene/scene-generator-host";
import { encodeFramePlan } from "./codec";
import type { EffectExecution } from "./effect-execution-plan";
import { buildFrameHeader } from "./root-post-plan";
import { buildRootScenePlan } from "./root-scene-plan";

export function rootSceneFixtures() {
  const composition = createBlankComposition();
  const header = buildFrameHeader({
    snapshot: { snapshotScope: "root-command-fixture", projectRevision: 1 },
    compositionId: "root\ud800",
    time: 1 / 3,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
  });
  const initial: RootSceneCommand = {
    kind: "begin_scene",
    group: "composition",
    color: { loadOp: "clear", storeOp: "store", clearValue: [-0, Number.MIN_VALUE, 1 / 3, 1] },
    depth: { loadOp: "clear", storeOp: "store", clearValue: 1 },
  };
  const effect: EffectExecution = {
    instanceId: "isolated\ud800",
    layerId: "layer\udfff",
    route: "layer",
    blendMode: "multiply",
    composite: "backdrop",
    fusion: { fusedEffectCount: 2, fusedGroupCount: 1, barrierCount: 0, operationCount: 2 },
  };
  const draws: SceneDrawPlan[] = [
    { kind: "none" },
    { kind: "media", hash: "a".repeat(64) },
    { kind: "media", hash: null },
    { kind: "surface", instanceId: "nested\ud800" },
    { kind: "raster-cache", instanceId: "text\udfff" },
    { kind: "none" },
    { kind: "none" },
  ].map((texture, index) => ({
    instanceId: index === 6 ? effect.instanceId : `draw-${index}\ud800`,
    firstVertex: index * 6,
    vertexCount: 6,
    blendMode: "screen",
    texture: texture as SceneDrawPlan["texture"],
    ...(index === 5
      ? {
          material: {
            instanceId: "material\ud800",
            active: true,
            normalEnabled: true,
            normalScale: -0,
            environmentIntensity: Number.MIN_VALUE,
            environmentRotation: 1 / 3,
            normalHash: "b".repeat(64),
            environmentHash: "c".repeat(64),
          },
        }
      : {}),
  }));
  const mixed: RootSceneCommand[] = [
    initial,
    ...draws
      .slice(0, 6)
      .map(
        (_, drawIndex): RootSceneCommand => ({ kind: "geometry", drawIndex, blendMode: "screen" }),
      ),
    { kind: "end_scene" },
    { kind: "begin_layer", effect },
    { kind: "geometry", drawIndex: 6, blendMode: "normal" },
    { kind: "finish_layer" },
    {
      kind: "adjustment",
      effect: { ...effect, instanceId: "adjustment", route: "adjustment", composite: "replace" },
    },
    {
      ...initial,
      group: "generator",
      color: { ...initial.color, loadOp: "load" },
      depth: { ...initial.depth, loadOp: "load" },
    },
    { kind: "generator", instanceId: "particles\ud800", blendMode: "add" },
    { kind: "end_scene" },
  ];
  return ["empty", "mixed", "clear-bits"].map((name) => {
    const root = structuredClone({
      commands: name === "empty" ? [initial, { kind: "end_scene" } as const] : mixed,
      draws: name === "empty" ? [] : draws,
    });
    if (name === "clear-bits") {
      for (const command of root.commands)
        if (command.kind === "begin_scene") command.depth.clearValue = -0;
    }
    const plan = buildRootScenePlan(header, root.commands, root.draws);
    return { id: `root-${name}`, root, plan, bytes: encodeFramePlan(plan.metadata, plan.blobs) };
  });
}

/** Records the actual command consumer without a GPU; pixel replay is a separate gate. */
export function recordRootSceneExecution(root: {
  commands: RootSceneCommand[];
  draws: SceneDrawPlan[];
}) {
  const events: string[] = [];
  const pass = () => ({
    setVertexBuffer() {},
    setPipeline() {},
    setBindGroup() {},
    draw(count: number, _instances: number, first: number) {
      events.push(`draw:${first}:${count}`);
    },
    end() {
      events.push("end");
    },
  });
  const encoder = {
    beginRenderPass(descriptor: GPURenderPassDescriptor) {
      const color = [...descriptor.colorAttachments][0];
      events.push(
        `begin:${color?.loadOp}:${color?.storeOp}:${descriptor.depthStencilAttachment?.depthLoadOp}`,
      );
      return pass();
    },
  } as unknown as GPUCommandEncoder;
  const resources = {
    gpuProfiler: { writes() {} },
    shapeBuffer: {},
    lightingBindGroup: {},
    shapePipelines: { normal: {}, screen: {} },
    imagePipelines: { screen: {} },
    precompositionSurfaces: {
      bindingFor() {
        return {};
      },
      pipelineFor() {
        return {};
      },
    },
    mediaTextures: {
      bindGroup() {
        return {};
      },
    },
    materialTextures: {
      bindingFor() {
        return undefined;
      },
    },
    sceneGenerators: {
      draw(_pass: GPURenderPassEncoder, generator: PreparedSceneGenerator) {
        events.push(`generator:${generator.instanceId}`);
      },
    },
    layerEffects: {
      beginLayer() {
        events.push("layer");
        return pass();
      },
      finishLayer(_encoder: GPUCommandEncoder, _target: GPUTexture, input: GPURenderPassEncoder) {
        input.end();
        events.push("composite");
        return 2;
      },
      encodeAdjustment() {
        events.push("adjustment");
        return 2;
      },
    },
  } as unknown as RendererResources;
  const generators = new Map(
    root.commands
      .filter((c) => c.kind === "generator")
      .map((c) => [c.instanceId, { instanceId: c.instanceId } as PreparedSceneGenerator]),
  );
  executeRootScene({
    ...root,
    resources,
    encoder,
    effects: new Map(),
    generators,
    mediaBindings: {
      bindingForHash: (hash: string | null) => (hash === null ? undefined : {}),
    } as unknown as MediaBindingLease,
    sceneTexture: {} as GPUTexture,
    sceneView: {} as GPUTextureView,
    depthView: {} as GPUTextureView,
  });
  return events;
}
