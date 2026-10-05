import type { PreparedLayerEffect } from "../effects/layer-effect-plan";
import type { EffectExecution } from "../frame-plan/effect-execution-plan";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import { drawPlannedSceneBatch } from "../scene/draw-planned-scene-batch";
import type { SceneDrawPlan } from "../scene/scene-draw-plan";
import type { PreparedSceneGenerator } from "../scene/scene-generator-host";
import type { RootSceneCommand } from "./root-scene-commands";

export function executeRootScene(input: {
  commands: readonly RootSceneCommand[];
  draws: readonly SceneDrawPlan[];
  effects: ReadonlyMap<string, PreparedLayerEffect>;
  generators: ReadonlyMap<string, PreparedSceneGenerator>;
  mediaBindings: MediaBindingLease;
  resources: RendererResources;
  encoder: GPUCommandEncoder;
  sceneTexture: GPUTexture;
  sceneView: GPUTextureView;
  depthView: GPUTextureView;
}) {
  const { resources, encoder, sceneTexture, sceneView, depthView } = input;
  const result = {
    scenePassCount: 0,
    effectOperationCount: 0,
    effectLayerCount: 0,
    adjustmentEffectLayerCount: 0,
    fusedEffectCount: 0,
    fusionGroupCount: 0,
    fusionBarrierCount: 0,
    generatorDrawCount: 0,
    activeEffectInstances: new Set<string>(),
    adjustmentErrors: [] as { layerId: string; message: string }[],
  };
  let pass: GPURenderPassEncoder | undefined;
  let layer: EffectExecution | undefined;
  const addFusion = (effect: EffectExecution) => {
    result.fusedEffectCount += effect.fusion.fusedEffectCount;
    result.fusionGroupCount += effect.fusion.fusedGroupCount;
    result.fusionBarrierCount += effect.fusion.barrierCount;
  };
  for (const command of input.commands) {
    switch (command.kind) {
      case "begin_scene": {
        if (pass) throw new Error("Scene pass overlaps another pass");
        const [r, g, b, a] = command.color.clearValue;
        pass = encoder.beginRenderPass({
          label:
            command.group === "composition"
              ? "Linear HDR composition"
              : command.group === "generator"
                ? "Linear HDR scene generator group"
                : "Linear HDR direct layer group",
          ...(command.group === "composition"
            ? { timestampWrites: resources.gpuProfiler.writes(4) }
            : {}),
          colorAttachments: [
            {
              view: sceneView,
              clearValue: { r, g, b, a },
              loadOp: command.color.loadOp,
              storeOp: command.color.storeOp,
            },
          ],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: command.depth.clearValue,
            depthLoadOp: command.depth.loadOp,
            depthStoreOp: command.depth.storeOp,
          },
        });
        result.scenePassCount += 1;
        break;
      }
      case "end_scene":
        if (!pass || layer) throw new Error("Scene pass end is unmatched");
        pass.end();
        pass = undefined;
        break;
      case "begin_layer":
        if (pass) throw new Error("Layer pass overlaps another pass");
        layer = command.effect;
        pass = resources.layerEffects.beginLayer(encoder, input.effects.get(layer.instanceId));
        break;
      case "finish_layer":
        if (!pass || !layer) throw new Error("Layer pass end is unmatched");
        result.effectOperationCount += resources.layerEffects.finishLayer(
          encoder,
          sceneTexture,
          pass,
        );
        result.effectLayerCount += 1;
        result.activeEffectInstances.add(layer.instanceId);
        addFusion(layer);
        pass = undefined;
        layer = undefined;
        break;
      case "adjustment": {
        if (pass) throw new Error("Adjustment overlaps a draw pass");
        const effect = command.effect;
        try {
          const count = resources.layerEffects.encodeAdjustment(
            encoder,
            sceneTexture,
            input.effects.get(effect.instanceId),
          );
          if (count > 0) {
            result.activeEffectInstances.add(effect.instanceId);
            result.adjustmentEffectLayerCount += 1;
            result.effectOperationCount += count;
            addFusion(effect);
          }
        } catch (error) {
          result.adjustmentErrors.push({
            layerId: effect.layerId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "geometry": {
        if (!pass) throw new Error("Geometry draw has no pass");
        const draw = input.draws[command.drawIndex];
        if (!draw) throw new Error("Geometry draw reference is absent");
        drawPlannedSceneBatch(resources, pass, draw, input.mediaBindings, command.blendMode);
        break;
      }
      case "generator": {
        if (!pass) throw new Error("Generator draw has no pass");
        const generator = input.generators.get(command.instanceId);
        if (!generator) throw new Error("Generator draw reference is absent");
        resources.sceneGenerators.draw(pass, generator, command.blendMode);
        result.generatorDrawCount += 1;
        break;
      }
    }
  }
  if (pass) throw new Error("Root commands leave a pass open");
  return result;
}
