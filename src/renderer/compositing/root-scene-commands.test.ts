import { describe, expect, it, vi } from "vitest";
import type { PreparedLayerEffect } from "../effects/layer-effect-plan";
import type { EffectExecution } from "../frame-plan/effect-execution-plan";
import { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import type { PreparedSceneGenerator } from "../scene/scene-generator-host";
import { executeRootScene } from "./execute-root-scene";
import type { PlannedSceneStack } from "./render-stack";
import { planRootSceneCommands } from "./root-scene-commands";

function execution(instanceId: string, route: EffectExecution["route"]): EffectExecution {
  return {
    instanceId,
    layerId: `layer-${instanceId}`,
    route,
    blendMode: "screen",
    composite: route === "layer" ? "fixed" : route === "adjustment" ? "replace" : "none",
    fusion: { fusedEffectCount: 2, fusedGroupCount: 1, barrierCount: 0, operationCount: 2 },
  };
}

function fixture() {
  const stack: PlannedSceneStack = {
    items: [
      { kind: "geometry", drawIndex: 0, instanceId: "back", clearDepth: false },
      { kind: "generator", instanceId: "missing", clearDepth: true },
      { kind: "adjustment", instanceId: "skip", clearDepth: false },
      { kind: "geometry", drawIndex: 1, instanceId: "isolated", clearDepth: false },
      { kind: "adjustment", instanceId: "adjustment", clearDepth: false },
      { kind: "generator", instanceId: "particles", clearDepth: false },
      { kind: "generator", instanceId: "particles", clearDepth: false },
      { kind: "geometry", drawIndex: 2, instanceId: "front", clearDepth: false },
    ],
    draws: ["back", "isolated", "front"].map((instanceId, i) => ({
      instanceId,
      firstVertex: i * 6,
      vertexCount: 6,
      blendMode: "screen",
      texture: { kind: "none" },
    })),
  };
  const effects = new Map(
    [
      execution("back", "direct"),
      execution("isolated", "layer"),
      execution("adjustment", "adjustment"),
      execution("skip", "skip"),
      execution("particles", "direct"),
      execution("front", "direct"),
    ].map((effect) => [effect.instanceId, effect]),
  );
  return { stack, effects };
}

describe("root scene commands", () => {
  it("preserves depth resets across skipped and isolated items and owns routing decisions", () => {
    const { stack, effects } = fixture();
    const commands = planRootSceneCommands(stack, effects, new Set(["particles"]), [0.1, 0, 0, 1]);
    const snapshot = structuredClone(commands);
    effects.clear();
    stack.items.reverse();
    expect(commands).toEqual(snapshot);
    expect(commands.map((c) => c.kind)).toEqual([
      "begin_scene",
      "geometry",
      "end_scene",
      "begin_layer",
      "geometry",
      "finish_layer",
      "adjustment",
      "begin_scene",
      "generator",
      "geometry",
      "end_scene",
    ]);
    const passes = commands.filter((c) => c.kind === "begin_scene");
    expect(passes.map((c) => c.depth.loadOp)).toEqual(["clear", "clear"]);
    expect(passes.map((c) => c.color.loadOp)).toEqual(["clear", "load"]);
    expect(commands.filter((c) => c.kind === "geometry").map((c) => c.blendMode)).toEqual([
      "screen",
      "normal",
      "screen",
    ]);
  });

  it("executes supplied order and attachment operations; removing a command removes its GPU draw", () => {
    const { stack, effects } = fixture();
    const commands = planRootSceneCommands(stack, effects, new Set(["particles"]), [0.1, 0, 0, 1]);
    const events: string[] = [];
    const makePass = (label: string) => ({
      setVertexBuffer: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: (count: number, _instances: number, first: number) =>
        events.push(`draw:${first}:${count}`),
      end: () => events.push(`end:${label}`),
    });
    const beginRenderPass = vi.fn((descriptor: GPURenderPassDescriptor) => {
      events.push(`begin:${descriptor.label}`);
      return makePass("scene");
    });
    const encoder = { beginRenderPass } as unknown as GPUCommandEncoder;
    const resources = {
      gpuProfiler: { writes: vi.fn() },
      shapeBuffer: {},
      lightingBindGroup: {},
      shapePipelines: { screen: {}, normal: {} },
      layerEffects: {
        beginLayer: vi.fn(() => {
          events.push("begin:layer");
          return makePass("layer");
        }),
        finishLayer: vi.fn((_encoder, _target, pass: GPURenderPassEncoder) => {
          pass.end();
          events.push("composite");
          return 2;
        }),
        encodeAdjustment: vi.fn(() => {
          events.push("adjustment");
          return 2;
        }),
      },
      sceneGenerators: { draw: vi.fn(() => events.push("particles")) },
    };
    const lease = new MediaBindingLease([]);
    const input = {
      commands: structuredClone(commands),
      draws: structuredClone(stack.draws),
      effects: new Map<string, PreparedLayerEffect>(),
      generators: new Map([["particles", { instanceId: "particles" } as PreparedSceneGenerator]]),
      resources: resources as unknown as RendererResources,
      encoder,
      mediaBindings: lease,
      sceneTexture: {} as GPUTexture,
      sceneView: {} as GPUTextureView,
      depthView: {} as GPUTextureView,
    };
    const result = executeRootScene(input);
    expect(events).toEqual([
      "begin:Linear HDR composition",
      "draw:0:6",
      "end:scene",
      "begin:layer",
      "draw:6:6",
      "end:layer",
      "composite",
      "adjustment",
      "begin:Linear HDR scene generator group",
      "particles",
      "draw:12:6",
      "end:scene",
    ]);
    expect(result).toMatchObject({
      scenePassCount: 2,
      effectLayerCount: 1,
      adjustmentEffectLayerCount: 1,
      effectOperationCount: 4,
      generatorDrawCount: 1,
      fusedEffectCount: 4,
      fusionGroupCount: 2,
      fusionBarrierCount: 0,
      adjustmentErrors: [],
    });
    expect([...result.activeEffectInstances]).toEqual(["isolated", "adjustment"]);
    expect(beginRenderPass.mock.calls[1][0].depthStencilAttachment).toMatchObject({
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthClearValue: 1,
    });
    events.length = 0;
    input.commands = input.commands.filter((c) => !(c.kind === "geometry" && c.drawIndex === 2));
    input.draws[0].firstVertex = 42;
    resources.layerEffects.encodeAdjustment.mockImplementation(() => {
      throw Error("bad LUT");
    });
    const changed = executeRootScene(input);
    expect(events).toContain("draw:42:6");
    expect(events).not.toContain("draw:12:6");
    expect(events).toContain("particles");
    expect(changed.adjustmentErrors).toEqual([{ layerId: "layer-adjustment", message: "bad LUT" }]);
    expect(changed.adjustmentEffectLayerCount).toBe(0);
    lease.release();
  });
});
