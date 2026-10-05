import { auxiliaryTextureKey, readAuxiliaryPlan } from "../frame-plan/auxiliary-plan";
import { requirePlan } from "../frame-plan/canonical";
import { compositionIdentityToString } from "../frame-plan/composition-identity";
import type { readFrameBundle } from "../frame-plan/frame-bundle-read";
import { readPostEffectPlan } from "../frame-plan/post-effect-plan";
import type { AuxiliaryPlanBindings } from "../gpu/auxiliary-plan-bindings";
import type { RendererResources } from "../renderer-resources";
import type { SuppliedFrameAssets } from "./supplied-frame-assets";

/** Realize only captured descriptors; no composition, project or authoring preferences enter here. */
export function prepareSuppliedFrame(
  decoded: ReturnType<typeof readFrameBundle>,
  resources: RendererResources,
  assets: SuppliedFrameAssets,
) {
  const { width, height } = decoded.plans.post.metadata.header.render_target;
  const media = assets.media;
  requirePlan(media, "missing_resource", "Supplied frame media was not installed");
  resources.configureShadowMap(decoded.shadowMapSize);
  resources.sceneGenerators.beginPlannedFrame();
  if (decoded.precompositionBundle)
    resources.precompositionSurfaces.prepareBundle(decoded.precompositionBundle, {
      memoryBudgetMb: 2048,
    });
  const generators = decoded.generators.map((plan) => {
    const prepared = resources.sceneGenerators.preparePlan(plan);
    requirePlan(
      prepared.effectiveCount === plan.effectiveCount,
      "resource_generation_mismatch",
      "Supplied generator workload differs",
    );
    return prepared;
  });
  const auxiliaryBindings = {
    media: new Map<string, GPUBindGroup>(),
    generators: new Map<
      string,
      NonNullable<ReturnType<typeof resources.sceneGenerators.auxiliaryDraw>>
    >(),
  } satisfies AuxiliaryPlanBindings;
  const auxiliary = decoded.plans.output.auxiliary
    ? readAuxiliaryPlan(decoded.plans.output.auxiliary)
    : undefined;
  if (auxiliary && auxiliary.slice.status !== "unavailable") {
    requirePlan(
      resources.auxiliaryBuffers.enable(
        width,
        height,
        512 * 1024 * 1024,
        auxiliary.slice.tier >= 0,
      ),
      "resource_budget_exceeded",
      "Supplied auxiliary targets cannot be allocated",
    );
    for (const draw of auxiliary.slice.draws) {
      const texture = draw.texture;
      if (texture.kind === "none") continue;
      const binding =
        texture.kind === "media"
          ? media.bindingForHash(texture.hash)
          : texture.kind === "surface"
            ? resources.precompositionSurfaces.bindingFor(
                compositionIdentityToString(texture.instance_id),
              )
            : undefined;
      requirePlan(binding, "missing_resource", "Supplied auxiliary texture is absent");
      auxiliaryBindings.media.set(auxiliaryTextureKey(texture), binding);
    }
    for (const generator of generators) {
      const draw = resources.sceneGenerators.auxiliaryDraw(generator);
      if (draw) auxiliaryBindings.generators.set(generator.instanceId, draw);
    }
    const range = Math.max(width, height);
    resources.bufferVisualizer.setAuxiliarySources(resources.auxiliaryBuffers.textures, [
      -range,
      range,
    ]);
  } else {
    resources.auxiliaryBuffers.disable();
    resources.bufferVisualizer.clearAuxiliarySources();
  }
  const motion = decoded.plans.output.motion.metadata.slices[0];
  requirePlan(
    motion.kind === "motion_reconstruction",
    "invalid_header",
    "Expected motion reconstruction",
  );
  const motionReady = motion.status === "ready";
  const aux = resources.auxiliaryBuffers;
  resources.motionBlur.setSources(
    width,
    height,
    motionReady ? resources.sceneTexture : undefined,
    motionReady ? aux.textures.get("motionVector") : undefined,
    motionReady ? aux.textures.get("objectId") : undefined,
    256 * 1024 * 1024,
  );
  resources.motionBlurPostBindGroup = resources.motionBlur.outputTexture
    ? resources.createPostBindGroup(resources.motionBlur.outputTexture, "supplied motion")
    : undefined;
  const effect = decoded.plans.output.effect
    ? readPostEffectPlan(decoded.plans.output.effect).slice.effect
    : undefined;
  const sceneRole =
    effect?.kind === "depth" && effect.inputs[0] === "motion_blur" ? "motion_blur" : "scene";
  resources.depthEffects.setSources(
    width,
    height,
    sceneRole === "motion_blur" ? resources.motionBlur.outputTexture : resources.sceneTexture,
    aux.textures.get("worldPosition"),
    aux.transparentWorldPosition,
    aux.peeledWorldPosition,
    aux.frontLayerColor,
    aux.peeledLayerColor,
    sceneRole,
  );
  resources.surfacePostEffects.setSources(
    width,
    height,
    resources.sceneTexture,
    aux.textures.get("objectId"),
    aux.textures.get("motionVector"),
  );
  resources.sceneGenerators.sweep();
  return { generators, auxiliaryBindings };
}
