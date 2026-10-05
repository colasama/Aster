import { effectExecution } from "../effects/layer-effect-plan";
import { validateMediaPixelLayout } from "../media/media-pixel-payload";
import { constrainGeneratorPlan } from "../scene/scene-generator-plan";
import { readBundlePrograms } from "./bundle-programs-read";
import { canonicalJson, requirePlan } from "./canonical";
import type { FrameBundle } from "./frame-bundle-plan";
import { validateFrameOutputPlans } from "./frame-output-plans";
import { readGeneratorSlice } from "./generator-plan";
import { readPrecompositionBundle } from "./precomposition-bundle-read";
import { PrecompositionBundleResources } from "./precomposition-bundle-resources";
import { readRootScenePlan } from "./root-scene-plan";
import { prepareSceneBuffers } from "./scene-buffer-upload";
import { defaultFramePlanLimits, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

/** Reject missing or mismatched dependencies before a frame can record GPU commands. */
export function readFrameBundle(input: FrameBundle) {
  const resources = new PrecompositionBundleResources();
  for (const packet of input.resources) resources.add(packet);
  return readValidatedFrameBundle(input.plan, resources);
}

/** Same decoding and rejection rules, with native asynchronous hashing for captured pixel data. */
export async function readFrameBundleAsync(input: FrameBundle) {
  const plan = structuredClone(input.plan);
  const resources = new PrecompositionBundleResources();
  // Snapshot all packets before the first await so the caller can release or reuse its buffers.
  const packets = structuredClone(input.resources);
  for (const packet of packets) await resources.addAsync(packet);
  return readValidatedFrameBundle(plan, resources);
}

function readValidatedFrameBundle(
  plan: FramePlanSliceData,
  resources: PrecompositionBundleResources,
) {
  const input = { plan };
  canonicalJson(input.plan.metadata);
  const metadata = validateMetadata(input.plan.metadata, defaultFramePlanLimits());
  const bundle = metadata.slices[0];
  requirePlan(
    metadata.contract_level === "frame_bundle_slice_v1" &&
      bundle.kind === "frame_bundle" &&
      input.plan.blobs.length === 1,
    "invalid_header",
    "Expected one root frame bundle",
  );
  validatePlanBlob(input.plan.blobs[0], metadata, 0);
  const matchingFrame = (plan: FramePlanSliceData) =>
    requirePlan(
      canonicalJson(plan.metadata.header) === canonicalJson(metadata.header),
      "invalid_header",
      "Bundled root stage frame differs",
    );
  const stage = (hash: string, contract: FramePlanSliceData["metadata"]["contract_level"]) => {
    const plan = resources.plan(hash, contract);
    matchingFrame(plan);
    return plan;
  };
  const scene = stage(bundle.scene, "scene_buffers_slice_v1"),
    root = stage(bundle.root, "root_scene_commands_slice_v1"),
    post = stage(bundle.post, "post_uniforms_slice_v1");
  const output = {
    output: stage(bundle.output, "final_output_slice_v1"),
    motion: stage(bundle.motion, "motion_reconstruction_slice_v1"),
    auxiliary: bundle.auxiliary ? stage(bundle.auxiliary, "auxiliary_slice_v1") : null,
    effect: bundle.effect ? stage(bundle.effect, "post_effect_slice_v1") : null,
  };
  validateFrameOutputPlans(output);
  const buffers = prepareSceneBuffers(scene),
    commands = readRootScenePlan(root);
  for (const draw of commands.draws)
    requirePlan(
      buffers.draws.some(
        (d) =>
          d.instanceId === draw.instanceId &&
          d.firstVertex === draw.firstVertex &&
          d.vertexCount === draw.vertexCount,
      ),
      "invalid_root_scene",
      "Root draw differs from bundled geometry",
    );
  const { effects, generators } = readBundlePrograms(
    bundle.effects,
    bundle.generators,
    resources,
    matchingFrame,
  );
  for (const command of commands.commands) {
    if (command.kind === "begin_layer" || command.kind === "adjustment")
      requirePlan(
        JSON.stringify(effectExecution(effects.get(command.effect.instanceId))) ===
          JSON.stringify(command.effect),
        "invalid_effect_execution",
        "Root effect route differs from supplied program",
      );
    if (command.kind === "generator")
      requirePlan(
        generators.some((g) => g.instanceId === command.instanceId),
        "missing_resource",
        "Root generator invocation is absent",
      );
  }
  const recursive = bundle.precompositions
    ? resources.plan(bundle.precompositions, "precomposition_bundle_slice_v1")
    : null;
  const precompositions = recursive
    ? readPrecompositionBundle(
        recursive,
        recursive.metadata.resources.map((hash) => resources.resolve(hash)),
      ).plans
    : [];
  const mediaFrames = [...resources.used].sort().flatMap((hash) => {
    const packet = resources.resolve(hash);
    return packet.message.kind === "media_frame" ? [packet.message] : [];
  });
  const requiredMedia = new Set(mediaFrames.map((frame) => frame.hash));
  const mediaPixels = bundle.media_pixels.map((link) => {
    requirePlan(
      requiredMedia.has(link.frame),
      "invalid_resource",
      "Unreferenced frame media pixels",
    );
    const capture = {
      frame: resources.resolve(link.frame).message,
      pixels: resources.resolve(link.pixels),
    };
    validateMediaPixelLayout(capture);
    return capture;
  });
  requirePlan(
    canonicalJson([...resources.used].sort()) === canonicalJson(metadata.resources),
    "invalid_resource",
    "Frame dependency closure differs from declarations",
  );
  return {
    mediaFrames,
    mediaPixels,
    plans: { scene, root, post, output, precompositions },
    effects,
    generators: generators.map((g) => {
      requirePlan(
        g.execution?.status === "ready",
        "invalid_generator",
        "Missing root generator outcome",
      );
      const plan = readGeneratorSlice(g.plan, new Map(g.shaders.map((s) => [s.message.hash, s])));
      return {
        ...constrainGeneratorPlan(plan, g.execution.capacity),
        capacity: Math.min(plan.capacity, g.execution.capacity),
      };
    }),
    shadowMapSize: bundle.shadow_map_size,
  };
}
