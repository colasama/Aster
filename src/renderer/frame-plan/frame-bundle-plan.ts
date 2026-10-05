import type { PreparedLayerEffect } from "../effects/layer-effect-plan";
import type { SceneGeneratorPlan } from "../scene/scene-generator-plan";
import { buildBundleEffects } from "./bundle-effect-records";
import { compositionIdentityFromString } from "./composition-identity";
import type { FrameBundleSlice } from "./frame-bundle-layout";
import { type FrameOutputPlans, validateFrameOutputPlans } from "./frame-output-plans";
import { buildGeneratorSlice } from "./generator-plan";
import {
  type BundleResource,
  PrecompositionBundleResources,
} from "./precomposition-bundle-resources";
import { defaultFramePlanLimits, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export interface FrameBundle {
  plan: FramePlanSliceData;
  resources: readonly BundleResource[];
}
export interface FrameBundleInput {
  scene: FramePlanSliceData;
  root: FramePlanSliceData;
  post: FramePlanSliceData;
  output: FrameOutputPlans;
  shadowMapSize: number;
  effects: ReadonlyMap<string, PreparedLayerEffect>;
  generators: readonly { plan: SceneGeneratorPlan; capacity: number }[];
  resources: readonly BundleResource[];
  precompositions?: FrameBundle;
  temporal?: readonly FramePlanSliceData[];
}
/** Assemble one frame from observed plans and cache payloads, without evaluating source objects. */
export function buildFrameBundle(input: FrameBundleInput): FrameBundle {
  const { header } = validateFrameOutputPlans(input.output);
  const resources = new PrecompositionBundleResources();
  for (const packet of [...input.resources, ...(input.precompositions?.resources ?? [])])
    resources.add(packet);
  const optional = (plan: FramePlanSliceData | null | undefined) =>
    plan ? resources.addPlan(plan) : null;
  const bundle: FrameBundleSlice = {
    kind: "frame_bundle",
    blob_index: 0,
    scene: resources.addPlan(input.scene),
    root: resources.addPlan(input.root),
    post: resources.addPlan(input.post),
    motion: resources.addPlan(input.output.motion),
    output: resources.addPlan(input.output.output),
    auxiliary: optional(input.output.auxiliary),
    effect: optional(input.output.effect),
    precompositions: optional(input.precompositions?.plan),
    shadow_map_size: input.shadowMapSize,
    media_pixels: [],
    temporal: (input.temporal ?? []).map((plan) => resources.addPlan(plan)),
    effects: buildBundleEffects(input.effects, resources),
    generators: input.generators.map(({ plan: generator, capacity }) => {
      for (const shader of generator.program.shaders) resources.add(shader);
      return {
        instance_id: compositionIdentityFromString(generator.instanceId),
        plan: resources.addPlan(buildGeneratorSlice(header, generator)),
        layer_name_utf16: [],
        plugin_id_utf16: [],
        execution: {
          status: "ready",
          capacity,
          effective_count: generator.effectiveCount,
        },
      };
    }),
  };
  const markPlan = (hash: string, contract: FramePlanSliceData["metadata"]["contract_level"]) =>
    resources.plan(hash, contract);
  markPlan(bundle.scene, "scene_buffers_slice_v1");
  markPlan(bundle.root, "root_scene_commands_slice_v1");
  markPlan(bundle.post, "post_uniforms_slice_v1");
  markPlan(bundle.motion, "motion_reconstruction_slice_v1");
  markPlan(bundle.output, "final_output_slice_v1");
  if (bundle.auxiliary) markPlan(bundle.auxiliary, "auxiliary_slice_v1");
  if (bundle.effect) markPlan(bundle.effect, "post_effect_slice_v1");
  if (bundle.precompositions) markPlan(bundle.precompositions, "precomposition_bundle_slice_v1");
  for (const effect of bundle.effects) {
    markPlan(effect.execution, "effect_execution_slice_v1");
    if (effect.status === "ready") {
      markPlan(effect.plan, "layer_effects_slice_v1");
      resources.resolve(effect.lut);
    }
  }
  for (const generator of bundle.generators) markPlan(generator.plan, "scene_generator_slice_v1");
  for (const plan of bundle.temporal) markPlan(plan, "temporal_text_passes_slice_v1");
  const bytes = new Uint8Array(24),
    view = new DataView(bytes.buffer);
  [
    bundle.shadow_map_size,
    bundle.effects.length,
    bundle.generators.length,
    Number(bundle.precompositions !== null),
    bundle.media_pixels.length,
    bundle.temporal.length,
  ].forEach((value, index) => {
    view.setUint32(index * 4, value, true);
  });
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "frame_bundle_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [...resources.used].sort(),
      blobs: [{ byte_offset: 0, byte_length: 24, element_type: "u32_le", element_count: 6 }],
      slices: [bundle],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return {
    plan: { metadata, blobs: [bytes] },
    resources: metadata.resources.map((hash) => resources.resolve(hash)),
  };
}
