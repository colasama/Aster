import { requirePlan } from "../frame-plan/canonical";
import { bindSceneMediaPlan, resolveSceneMediaPlan } from "../frame-plan/scene-media-plan";
import type {
  PrecompositionSceneInputs,
  PrecompositionScenePlan,
} from "./precomposition-scene-plan";

export interface PrecompositionMediaBindings {
  bindingForHash(hash: string): GPUBindGroup | undefined;
}

/** Resolve authoring instance addresses once, while the frame's media owners are retained. */
export function bindPrecompositionSceneMedia(
  input: PrecompositionSceneInputs,
  resources: PrecompositionMediaBindings & { hashFor(instanceId: string): string | null },
): PrecompositionScenePlan {
  const draws = input.draws.map((draw) => ({
    ...draw,
    texture:
      draw.texture.kind === "media"
        ? { kind: "media" as const, hash: resources.hashFor(draw.texture.instanceId) }
        : { ...draw.texture },
  }));
  const scene = bindSceneMediaPlan(
    input.scene,
    draws
      .flatMap((draw) =>
        draw.texture.kind === "media"
          ? [
              {
                draw_index: draw.sceneDrawIndex,
                binding:
                  draw.texture.hash === null
                    ? { kind: "pending" as const }
                    : { kind: "frame" as const, hash: draw.texture.hash },
              },
            ]
          : [],
      )
      .sort((a, b) => a.draw_index - b.draw_index),
  );
  const plan = { ...input, scene, draws };
  resolvePrecompositionSceneMedia(plan, resources);
  return plan;
}

/** Preflight every supplied media dependency before any compute or render pass is recorded. */
export function resolvePrecompositionSceneMedia(
  plan: PrecompositionScenePlan,
  resources: PrecompositionMediaBindings,
): Map<number, GPUBindGroup | undefined> {
  const resolved = new Map(
    resolveSceneMediaPlan(plan.scene, resources).map((m) => [m.drawIndex, m]),
  );
  const bindings = new Map<number, GPUBindGroup | undefined>();
  plan.draws.forEach((draw, index) => {
    if (draw.texture.kind !== "media") return;
    const media = resolved.get(draw.sceneDrawIndex);
    requirePlan(
      media && media.hash === draw.texture.hash,
      "missing_resource",
      "Precomposition media reference differs from its scene slice",
    );
    bindings.set(index, media.binding);
    resolved.delete(draw.sceneDrawIndex);
  });
  requirePlan(
    resolved.size === 0,
    "invalid_scene_buffers",
    "Precomposition scene has unmatched media bindings",
  );
  return bindings;
}
