import { requirePlan } from "./canonical";
import { defaultFramePlanLimits, type FramePlanSliceData, type SceneMediaBinding } from "./types";
import { validateMetadata } from "./validation";

/** Adds resolved media references without copying the already-owned geometry payload. */
export function bindSceneMediaPlan(
  plan: FramePlanSliceData,
  bindings: readonly SceneMediaBinding[],
): FramePlanSliceData {
  const metadata = structuredClone(plan.metadata);
  requirePlan(
    metadata.contract_level === "scene_buffers_slice_v1" && metadata.slices.length === 1,
    "invalid_scene_buffers",
    "Media binding requires one scene slice",
  );
  const slice = metadata.slices[0];
  requirePlan(
    slice.kind === "scene_buffers" && slice.media_bindings.length === 0,
    "invalid_scene_buffers",
    "Scene media references are already bound",
  );
  slice.media_bindings = structuredClone([...bindings]);
  metadata.resources = [
    ...new Set([
      ...metadata.resources,
      ...bindings.flatMap(({ binding }) => (binding.kind === "frame" ? [binding.hash] : [])),
    ]),
  ].sort();
  return { metadata: validateMetadata(metadata, defaultFramePlanLimits()), blobs: plan.blobs };
}

/** Resolves all supplied hashes before a caller encodes any media draw. */
export function resolveSceneMediaPlan(
  plan: FramePlanSliceData,
  resources: { bindingForHash(hash: string): GPUBindGroup | undefined },
): { drawIndex: number; hash: string | null; binding?: GPUBindGroup }[] {
  const metadata = validateMetadata(plan.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "scene_buffers_slice_v1" && metadata.slices.length === 1,
    "invalid_scene_buffers",
    "Media resolution requires one scene slice",
  );
  const slice = metadata.slices[0];
  requirePlan(slice.kind === "scene_buffers", "invalid_scene_buffers", "Missing scene slice");
  const resolved = new Map<string, GPUBindGroup>();
  for (const { binding } of slice.media_bindings) {
    if (binding.kind === "frame" && !resolved.has(binding.hash)) {
      const handle = resources.bindingForHash(binding.hash);
      requirePlan(handle, "missing_resource", "Media frame has no GPU binding");
      resolved.set(binding.hash, handle);
    }
  }
  return slice.media_bindings.map(({ draw_index, binding }) => ({
    drawIndex: draw_index,
    hash: binding.kind === "frame" ? binding.hash : null,
    binding: binding.kind === "frame" ? resolved.get(binding.hash) : undefined,
  }));
}
