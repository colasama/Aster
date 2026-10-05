import { canonicalJson, requirePlan } from "../frame-plan/canonical";
import { buildPrecompositionBundle } from "../frame-plan/precomposition-bundle-plan";
import { readPrecompositionBundle } from "../frame-plan/precomposition-bundle-read";
import { buildPrecompositionGraph } from "../frame-plan/precomposition-graph-plan";
import type { MediaBindingLease } from "../media/media-binding-lease";
import { captureMediaPixels } from "../media/media-pixel-capture";
import type { PrecompositionScenePlan } from "./precomposition-scene-plan";
import type { PrecompositionBundle } from "./precomposition-surface-renderer";

/** Capture already-evaluated data while its media lease remains held across asynchronous readback. */
export async function capturePrecompositionBundle(
  device: GPUDevice,
  bundle: PrecompositionBundle,
  media: MediaBindingLease,
  executed: readonly PrecompositionScenePlan[],
) {
  const captured = capturePrecompositionExecution(bundle, executed);
  const decoded = readPrecompositionBundle(captured.plan, captured.resources);
  const graph = buildPrecompositionGraph(
    structuredClone(bundle.plan.metadata.header),
    decoded.graph.nodes,
    decoded.graph.bindings,
  );
  const messages = bundle.resources
    .filter((r) => r.message.kind === "media_source" || r.message.kind === "media_frame")
    .map((r) => structuredClone(r.message));
  const frames = messages.filter((m) => m.kind === "media_frame");
  const pixels = await captureMediaPixels(device, media, frames);
  return buildPrecompositionBundle(graph, decoded.plans, messages, pixels);
}

/** Bind observed outcomes to the exact supplied scene and resource generation before any await. */
export function capturePrecompositionExecution(
  bundle: PrecompositionBundle,
  executed: readonly PrecompositionScenePlan[],
): PrecompositionBundle {
  const decoded = readPrecompositionBundle(bundle.plan, bundle.resources);
  const graph = buildPrecompositionGraph(
    bundle.plan.metadata.header,
    decoded.graph.nodes,
    decoded.graph.bindings,
  );
  const messages = bundle.resources
    .filter((r) => r.message.kind === "media_source" || r.message.kind === "media_frame")
    .map((r) => r.message);
  const captured = buildPrecompositionBundle(graph, executed, messages, decoded.mediaPixels);
  const observed = structuredClone(captured.plan.metadata);
  const original = bundle.plan.metadata.slices[0];
  const slice = observed.slices[0];
  requirePlan(
    original.kind === "precomposition_bundle" && slice.kind === "precomposition_bundle",
    "invalid_precomposition",
    "Expected execution bundle",
  );
  for (const [index, scene] of slice.scenes.entries())
    for (const [generatorIndex, generator] of scene.generators.entries()) {
      const prior = original.scenes[index]?.generators[generatorIndex];
      requirePlan(
        prior && generator.execution.status !== "planned",
        "missing_resource",
        "Generator execution has not completed",
      );
      generator.execution = structuredClone(prior.execution);
    }
  requirePlan(
    canonicalJson(observed) === canonicalJson(bundle.plan.metadata) &&
      captured.plan.blobs[0].every((value, index) => value === bundle.plan.blobs[0][index]),
    "resource_generation_mismatch",
    "Execution differs from captured scene generation",
  );
  return captured;
}
