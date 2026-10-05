// Extracted from e5130c134d13d1e442a6efa9cdc64466b620bc9a webgpu-renderer.ts.
// Only the enclosing fields/logger were replaced by arguments and returned diagnostics.
// Keep this pre-command root loop independent of the command planner and executor.
import type { Composition } from "../../../src/core/types";
import type { PlannedSceneStack } from "../../../src/renderer/compositing/render-stack";
import {
  effectExecution,
  type PreparedLayerEffect,
} from "../../../src/renderer/effects/layer-effect-plan";
import type { MediaBindingLease } from "../../../src/renderer/media/media-binding-lease";
import type { RendererResources } from "../../../src/renderer/renderer-resources";
import { drawPlannedSceneBatch } from "../../../src/renderer/scene/draw-planned-scene-batch";
import type { PreparedSceneGenerator } from "../../../src/renderer/scene/scene-generator-host";
export function legacyExecute(input: {
  composition: Pick<Composition, "background">;
  renderStack: PlannedSceneStack;
  effectPlans: ReadonlyMap<string, PreparedLayerEffect>;
  generatorByInstance: ReadonlyMap<string, PreparedSceneGenerator>;
  mediaBindings: MediaBindingLease;
  resources: RendererResources;
  encoder: GPUCommandEncoder;
  sceneTexture: GPUTexture;
  sceneView: GPUTextureView;
  depthView: GPUTextureView;
}) {
  const {
    composition,
    renderStack,
    effectPlans,
    generatorByInstance,
    mediaBindings,
    resources,
    encoder,
    sceneTexture,
    sceneView,
    depthView,
  } = input;
  let scenePass: GPURenderPassEncoder | undefined = encoder.beginRenderPass({
    label: "Linear HDR composition",
    timestampWrites: resources.gpuProfiler.writes(4),
    colorAttachments: [
      {
        view: sceneView,
        clearValue: {
          r: composition.background[0],
          g: composition.background[1],
          b: composition.background[2],
          a: composition.background[3],
        },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: depthView,
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  let scenePassCount = 1;
  let effectOperationCount = 0;
  let effectLayerCount = 0;
  let adjustmentEffectLayerCount = 0;
  let fusedEffectCount = 0;
  let fusionGroupCount = 0;
  let fusionBarrierCount = 0;
  const drawnGenerators = new Set<string>();
  const activeEffectInstances = new Set<string>();
  let clearSceneDepth = false;
  const adjustmentErrors: { layerId: string; message: string }[] = [];
  for (const item of renderStack.items) {
    if (item.clearDepth) {
      scenePass?.end();
      scenePass = undefined;
      clearSceneDepth = true;
    }
    if (item.kind === "adjustment") {
      const execution = effectExecution(effectPlans.get(item.instanceId));
      if (execution.route === "skip") continue;
      const fusion = execution.fusion;
      scenePass?.end();
      scenePass = undefined;
      try {
        const operationCount = resources.layerEffects.encodeAdjustment(
          encoder,
          sceneTexture,
          effectPlans.get(item.instanceId),
        );
        if (operationCount > 0) {
          activeEffectInstances.add(item.instanceId);
          adjustmentEffectLayerCount += 1;
          effectOperationCount += operationCount;
          fusedEffectCount += fusion.fusedEffectCount;
          fusionGroupCount += fusion.fusedGroupCount;
          fusionBarrierCount += fusion.barrierCount;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        adjustmentErrors.push({ layerId: execution.layerId, message });
      }
      continue;
    }
    if (item.kind === "generator") {
      const generator = generatorByInstance.get(item.instanceId);
      if (!generator || drawnGenerators.has(generator.instanceId)) continue;
      const execution = effectExecution(effectPlans.get(item.instanceId));
      if (execution.route === "layer") {
        const fusion = execution.fusion;
        scenePass?.end();
        scenePass = undefined;
        activeEffectInstances.add(item.instanceId);
        effectLayerCount += 1;
        effectOperationCount += resources.layerEffects.encode(
          encoder,
          sceneTexture,
          effectPlans.get(item.instanceId),
          (layerPass) => resources.sceneGenerators.draw(layerPass, generator, "normal"),
        );
        fusedEffectCount += fusion.fusedEffectCount;
        fusionGroupCount += fusion.fusedGroupCount;
        fusionBarrierCount += fusion.barrierCount;
        drawnGenerators.add(generator.instanceId);
        continue;
      }
      if (!scenePass) {
        scenePass = encoder.beginRenderPass({
          label: "Linear HDR scene generator group",
          colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 1,
            depthLoadOp: clearSceneDepth ? "clear" : "load",
            depthStoreOp: "store",
          },
        });
        scenePassCount += 1;
        clearSceneDepth = false;
      }
      resources.sceneGenerators.draw(scenePass, generator, execution.blendMode);
      drawnGenerators.add(generator.instanceId);
      continue;
    }
    const draw = renderStack.draws[item.drawIndex];
    const execution = effectExecution(effectPlans.get(item.instanceId));
    if (execution.route === "layer") {
      const fusion = execution.fusion;
      fusedEffectCount += fusion.fusedEffectCount;
      fusionGroupCount += fusion.fusedGroupCount;
      fusionBarrierCount += fusion.barrierCount;
      scenePass?.end();
      scenePass = undefined;
      activeEffectInstances.add(item.instanceId);
      effectLayerCount += 1;
      effectOperationCount += resources.layerEffects.encode(
        encoder,
        sceneTexture,
        effectPlans.get(item.instanceId),
        (layerPass) => drawPlannedSceneBatch(resources, layerPass, draw, mediaBindings, "normal"),
      );
    } else {
      if (!scenePass) {
        scenePass = encoder.beginRenderPass({
          label: "Linear HDR direct layer group",
          colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 1,
            depthLoadOp: clearSceneDepth ? "clear" : "load",
            depthStoreOp: "store",
          },
        });
        scenePassCount += 1;
        clearSceneDepth = false;
      }
      drawPlannedSceneBatch(resources, scenePass, draw, mediaBindings, execution.blendMode);
    }
  }
  const generatorDrawCount = drawnGenerators.size;
  scenePass?.end();
  return {
    scenePassCount,
    effectOperationCount,
    effectLayerCount,
    adjustmentEffectLayerCount,
    fusedEffectCount,
    fusionGroupCount,
    fusionBarrierCount,
    generatorDrawCount,
    activeEffectInstances,
    adjustmentErrors,
  };
}
