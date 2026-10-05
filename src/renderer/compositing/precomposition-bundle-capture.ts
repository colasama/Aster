import { buildPrecompositionBundle } from "../frame-plan/precomposition-bundle-plan";
import { readPrecompositionBundle } from "../frame-plan/precomposition-bundle-read";
import { buildPrecompositionGraph } from "../frame-plan/precomposition-graph-plan";
import type { MediaBindingLease } from "../media/media-binding-lease";
import { captureMediaPixels } from "../media/media-pixel-capture";
import type { PrecompositionBundle } from "./precomposition-surface-renderer";

/** Capture already-evaluated data while its media lease remains held across asynchronous readback. */
export async function capturePrecompositionBundle(
  device: GPUDevice,
  bundle: PrecompositionBundle,
  media: MediaBindingLease,
) {
  const decoded = readPrecompositionBundle(bundle.plan, bundle.resources);
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
