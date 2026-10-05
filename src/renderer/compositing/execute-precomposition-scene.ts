import type { BlendMode } from "../../core/types";
import type { LayerEffectRenderer } from "../effects/layer-effects";
import { requirePlan } from "../frame-plan/canonical";
import type { PreparedSceneGenerator, SceneGeneratorHost } from "../scene/scene-generator-host";
import type { PrecompositionScenePlan } from "./precomposition-scene-plan";

export interface PrecompositionExecutionTarget {
  color: GPUTexture;
  depth: GPUTexture;
  bindGroup: GPUBindGroup;
  vertexBuffer: GPUBuffer;
  lightingBindGroup: GPUBindGroup;
  effects?: LayerEffectRenderer;
}
export function executePrecompositionScene(input: {
  plan: PrecompositionScenePlan;
  encoder: GPUCommandEncoder;
  targets: ReadonlyMap<string, PrecompositionExecutionTarget>;
  generators: ReadonlyMap<string, PreparedSceneGenerator>;
  host?: SceneGeneratorHost;
  mediaBinding: (instanceId: string) => GPUBindGroup | undefined;
  surfacePipelines: Record<BlendMode, GPURenderPipeline>;
  imagePipelines: Record<BlendMode, GPURenderPipeline>;
  shapePipelines: Record<BlendMode, GPURenderPipeline>;
}): void {
  const { plan, encoder } = input;
  const target = input.targets.get(plan.target.id);
  requirePlan(target, "missing_resource", "Precomposition output target is absent");
  for (const draw of plan.draws)
    if (draw.texture.kind === "surface" && draw.texture.targetId !== null)
      requirePlan(
        input.targets.has(draw.texture.targetId),
        "missing_resource",
        "Precomposition child target is absent",
      );
  const generators = plan.generators.map((p) => {
    const prepared = input.generators.get(p.instanceId);
    requirePlan(prepared && input.host, "missing_resource", "Precomposition generator is absent");
    return prepared;
  });
  if (generators.length) {
    const compute = encoder.beginComputePass({
      label: `Precomposition scene generators · ${plan.label}`,
    });
    for (const generator of generators) input.host?.encodeCompute(compute, generator);
    compute.end();
  }
  let pass: GPURenderPassEncoder | undefined, layerId: string | undefined;
  const active = new Set<string>();
  for (const command of plan.commands)
    switch (command.kind) {
      case "begin_scene": {
        requirePlan(!pass, "invalid_root_scene", "Precomposition passes overlap");
        const [r, g, b, a] = command.color.clearValue;
        pass = encoder.beginRenderPass({
          label:
            command.group === "composition"
              ? `Isolated precomposition · ${plan.label}`
              : "Resume isolated precomposition stack",
          colorAttachments: [
            {
              view: target.color.createView(),
              clearValue: { r, g, b, a },
              loadOp: command.color.loadOp,
              storeOp: command.color.storeOp,
            },
          ],
          depthStencilAttachment: {
            view: target.depth.createView(),
            depthClearValue: command.depth.clearValue,
            depthLoadOp: command.depth.loadOp,
            depthStoreOp: command.depth.storeOp,
          },
        });
        break;
      }
      case "end_scene":
        requirePlan(
          pass && !layerId,
          "invalid_root_scene",
          "Precomposition scene end is unmatched",
        );
        pass.end();
        pass = undefined;
        break;
      case "begin_layer":
        requirePlan(
          !pass && target.effects,
          "missing_resource",
          "Precomposition effect target is absent",
        );
        layerId = command.effect.instanceId;
        pass = target.effects.beginLayer(encoder, plan.effects.get(layerId));
        break;
      case "finish_layer":
        requirePlan(
          pass && layerId && target.effects,
          "invalid_root_scene",
          "Precomposition effect end is unmatched",
        );
        target.effects.finishLayer(encoder, target.color, pass);
        active.add(layerId);
        layerId = undefined;
        pass = undefined;
        break;
      case "adjustment": {
        requirePlan(
          !pass && target.effects,
          "missing_resource",
          "Precomposition adjustment target is absent",
        );
        const count = target.effects.encodeAdjustment(
          encoder,
          target.color,
          plan.effects.get(command.effect.instanceId),
        );
        if (count) active.add(command.effect.instanceId);
        break;
      }
      case "generator": {
        const generator = input.generators.get(command.instanceId);
        requirePlan(
          pass && generator && input.host,
          "missing_resource",
          "Precomposition generator draw is absent",
        );
        input.host.draw(pass, generator, command.blendMode);
        break;
      }
      case "geometry": {
        requirePlan(pass, "invalid_root_scene", "Precomposition draw has no pass");
        const draw = plan.draws[command.drawIndex];
        requirePlan(draw, "missing_resource", "Precomposition draw is absent");
        pass.setVertexBuffer(0, target.vertexBuffer);
        const texture = draw.texture;
        if (texture.kind === "surface") {
          if (texture.targetId === null) break;
          const child = input.targets.get(texture.targetId);
          requirePlan(child, "missing_resource", "Precomposition child target is absent");
          pass.setPipeline(input.surfacePipelines[command.blendMode]);
          pass.setBindGroup(0, child.bindGroup);
        } else {
          const media =
            texture.kind === "media" ? input.mediaBinding(texture.instanceId) : undefined;
          pass.setPipeline(
            (media ? input.imagePipelines : input.shapePipelines)[command.blendMode],
          );
          pass.setBindGroup(0, media ?? target.lightingBindGroup);
        }
        pass.draw(draw.vertexCount, 1, draw.firstVertex);
        break;
      }
    }
  requirePlan(!pass, "invalid_root_scene", "Precomposition leaves a pass open");
  target.effects?.sweep(active);
}
