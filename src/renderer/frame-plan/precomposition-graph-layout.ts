import { integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { BlobDescriptor, CompositionIdentity, FramePlanLimits } from "./types";

export interface PrecompositionTargetRecord {
  id: CompositionIdentity;
  width: number;
  height: number;
  estimated_bytes: number;
  texture_count: number;
  has_effects: boolean;
  draw_count: number;
}
export interface PrecompositionGraphSlice {
  kind: "precomposition_graph";
  blob_index: number;
  targets: PrecompositionTargetRecord[];
  bindings: { instance_id: CompositionIdentity; target_index: number }[];
}
export const PRECOMPOSITION_GRAPH_FIELDS = ["kind", "blob_index", "targets", "bindings"];

export function validatePrecompositionGraph(
  value: unknown,
  blob: BlobDescriptor,
  limits: FramePlanLimits,
): void {
  const graph = object(value, PRECOMPOSITION_GRAPH_FIELDS);
  requirePlan(graph.kind === "precomposition_graph", "unknown_variant", "Unknown surface graph");
  requirePlan(
    Array.isArray(graph.targets) && graph.targets.length <= 10,
    "invalid_precomposition",
    "Surface graph exceeds target limit",
  );
  const ids = new Set<string>();
  let draws = 0,
    textures = 0;
  for (const value of graph.targets) {
    const target = object(value, [
      "id",
      "width",
      "height",
      "estimated_bytes",
      "texture_count",
      "has_effects",
      "draw_count",
    ]);
    const id = compositionIdentityToString(target.id);
    requirePlan(!ids.has(id), "invalid_precomposition", "Duplicate surface target");
    ids.add(id);
    const width = integer(target.width, 1, limits.max_dimension),
      height = integer(target.height, 1, limits.max_dimension);
    requirePlan(
      width * height <= limits.max_pixels && typeof target.has_effects === "boolean",
      "invalid_precomposition",
      "Invalid surface extent or effects flag",
    );
    requirePlan(
      integer(target.estimated_bytes) === width * height * (target.has_effects ? 38 : 12) &&
        integer(target.texture_count) === (target.has_effects ? 5 : 2),
      "invalid_precomposition",
      "Surface cache accounting mismatch",
    );
    draws += integer(target.draw_count, 0, 65536);
    textures += integer(target.texture_count);
  }
  requirePlan(
    draws <= 65536 && textures <= 20,
    "invalid_precomposition",
    "Surface graph budget exceeded",
  );
  requirePlan(
    Array.isArray(graph.bindings) && graph.bindings.length <= 65536,
    "invalid_precomposition",
    "Surface bindings exceed limit",
  );
  const aliases = new Set<string>();
  for (const value of graph.bindings) {
    const binding = object(value, ["instance_id", "target_index"]);
    const id = compositionIdentityToString(binding.instance_id);
    requirePlan(!aliases.has(id), "invalid_precomposition", "Duplicate surface binding");
    aliases.add(id);
    integer(binding.target_index, 0, graph.targets.length - 1);
  }
  requirePlan(
    blob.element_type === "u32_le" &&
      blob.element_count === draws + 4 &&
      blob.byte_length === (draws + 4) * 4,
    "invalid_precomposition",
    "Surface routing blob layout mismatch",
  );
}

export function validatePrecompositionGraphBlob(
  bytes: Uint8Array,
  graph: PrecompositionGraphSlice,
): void {
  const draws = graph.targets.reduce((n, target) => n + target.draw_count, 0);
  requirePlan(
    bytes.length === 16 + draws * 4,
    "invalid_precomposition",
    "Surface routing payload length mismatch",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requirePlan(
    view.getUint32(0, true) === graph.targets.length &&
      view.getUint32(4, true) === draws &&
      view.getUint32(8, true) === graph.bindings.length &&
      view.getUint32(12, true) === 0,
    "invalid_precomposition",
    "Surface routing header mismatch",
  );
  let offset = 16;
  graph.targets.forEach((target, index) => {
    for (let draw = 0; draw < target.draw_count; draw++, offset += 4) {
      const route = view.getUint32(offset, true);
      requirePlan(
        route < 2 || route - 2 < index,
        "invalid_precomposition",
        "Surface reference is not an earlier child target",
      );
    }
  });
}
