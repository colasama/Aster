import type { PreparedLayerEffect } from "../effects/layer-effect-plan";
import type { SceneGeneratorPlan } from "../scene/scene-generator-plan";
import { buildBundleEffects, buildBundleEffectsAsync } from "./bundle-effect-records";
import { compositionIdentityFromString } from "./composition-identity";
import type { FrameBundleSlice } from "./frame-bundle-layout";
import { type FrameOutputPlans, validateFrameOutputPlans } from "./frame-output-plans";
import { buildGeneratorSlice } from "./generator-plan";
import {
  type BundleResource,
  PrecompositionBundleResources,
} from "./precomposition-bundle-resources";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
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
  const optional = (
    plan: FramePlanSliceData | null | undefined,
    contract: FramePlanSliceData["metadata"]["contract_level"],
  ) => (plan ? resources.addRequiredPlan(plan, contract) : null);
  const bundle: FrameBundleSlice = {
    kind: "frame_bundle",
    blob_index: 0,
    scene: resources.addRequiredPlan(input.scene, "scene_buffers_slice_v1"),
    root: resources.addRequiredPlan(input.root, "root_scene_commands_slice_v1"),
    post: resources.addRequiredPlan(input.post, "post_uniforms_slice_v1"),
    motion: resources.addRequiredPlan(input.output.motion, "motion_reconstruction_slice_v1"),
    output: resources.addRequiredPlan(input.output.output, "final_output_slice_v1"),
    auxiliary: optional(input.output.auxiliary, "auxiliary_slice_v1"),
    effect: optional(input.output.effect, "post_effect_slice_v1"),
    precompositions: optional(input.precompositions?.plan, "precomposition_bundle_slice_v1"),
    shadow_map_size: input.shadowMapSize,
    media_pixels: [],
    temporal: (input.temporal ?? []).map((plan) =>
      resources.addRequiredPlan(plan, "temporal_text_passes_slice_v1"),
    ),
    effects: buildBundleEffects(input.effects, resources),
    generators: input.generators.map(({ plan: generator, capacity }) => {
      for (const shader of generator.program.shaders) resources.add(shader);
      return {
        instance_id: compositionIdentityFromString(generator.instanceId),
        plan: resources.addRequiredPlan(
          buildGeneratorSlice(header, generator),
          "scene_generator_slice_v1",
        ),
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
  return assembleFrameBundle(header, bundle, resources);
}

function assembleFrameBundle(
  header: FrameHeaderSlice,
  bundle: FrameBundleSlice,
  resources: PrecompositionBundleResources,
): FrameBundle {
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
      renderer_plan_complete: true,
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

/** Encode each producer input synchronously, then join independently owned plan digests. */
export async function buildFrameBundleAsync(input: FrameBundleInput): Promise<FrameBundle> {
  const { header } = validateFrameOutputPlans(input.output);
  const ownedHeader = structuredClone(header),
    shadowMapSize = input.shadowMapSize;
  const resources = new PrecompositionBundleResources();
  try {
    for (const packet of [...input.resources, ...(input.precompositions?.resources ?? [])])
      resources.add(packet);
    const optional = (
      plan: FramePlanSliceData | null | undefined,
      contract: FramePlanSliceData["metadata"]["contract_level"],
    ) => (plan ? resources.addRequiredPlanAsync(plan, contract) : Promise.resolve(null));
    const stages = Promise.all([
      resources.addRequiredPlanAsync(input.scene, "scene_buffers_slice_v1"),
      resources.addRequiredPlanAsync(input.root, "root_scene_commands_slice_v1"),
      resources.addRequiredPlanAsync(input.post, "post_uniforms_slice_v1"),
      resources.addRequiredPlanAsync(input.output.motion, "motion_reconstruction_slice_v1"),
      resources.addRequiredPlanAsync(input.output.output, "final_output_slice_v1"),
      optional(input.output.auxiliary, "auxiliary_slice_v1"),
      optional(input.output.effect, "post_effect_slice_v1"),
      optional(input.precompositions?.plan, "precomposition_bundle_slice_v1"),
    ] as const);
    void stages.catch(() => undefined);
    const temporal = Promise.all(
      (input.temporal ?? []).map((plan) =>
        resources.addRequiredPlanAsync(plan, "temporal_text_passes_slice_v1"),
      ),
    );
    void temporal.catch(() => undefined);
    const effects = buildBundleEffectsAsync(input.effects, resources);
    void effects.catch(() => undefined);
    const generators = Promise.all(
      input.generators.map(async ({ plan: generator, capacity }) => {
        for (const shader of generator.program.shaders) resources.add(shader);
        const instanceId = compositionIdentityFromString(generator.instanceId);
        const effectiveCount = generator.effectiveCount;
        const plan = await resources.addRequiredPlanAsync(
          buildGeneratorSlice(ownedHeader, generator),
          "scene_generator_slice_v1",
        );
        return {
          instance_id: instanceId,
          plan,
          layer_name_utf16: [],
          plugin_id_utf16: [],
          execution: { status: "ready" as const, capacity, effective_count: effectiveCount },
        };
      }),
    );
    const results = await Promise.allSettled([stages, temporal, effects, generators] as const);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const [stageResult, temporalResult, effectResult, generatorResult] = results;
    // Every rejection was handled above; separate checks preserve tuple narrowing.
    if (
      stageResult.status !== "fulfilled" ||
      temporalResult.status !== "fulfilled" ||
      effectResult.status !== "fulfilled" ||
      generatorResult.status !== "fulfilled"
    )
      throw new Error("Frame plan assembly failed");
    const [scene, root, post, motion, output, auxiliary, effect, precompositions] =
      stageResult.value;
    return assembleFrameBundle(
      ownedHeader,
      {
        kind: "frame_bundle",
        blob_index: 0,
        scene,
        root,
        post,
        motion,
        output,
        auxiliary,
        effect,
        precompositions,
        shadow_map_size: shadowMapSize,
        media_pixels: [],
        temporal: temporalResult.value,
        effects: effectResult.value,
        generators: generatorResult.value,
      },
      resources,
    );
  } finally {
    await resources.settle();
  }
}
