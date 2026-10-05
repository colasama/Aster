import { hash, integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { RootTextureReference } from "./root-scene-types";
import type { BlobDescriptor, CompositionIdentity } from "./types";

export type AuxiliaryTexture = Exclude<RootTextureReference, { kind: "pending" }>;
export interface AuxiliaryDraw {
  instance_id: CompositionIdentity;
  first_vertex: number;
  vertex_count: number;
  texture: AuxiliaryTexture;
}
export interface AuxiliarySlice {
  kind: "auxiliary";
  blob_index: number;
  status: "unavailable" | "cleared" | "drawn";
  tier: number;
  vertex_count: number;
  motion: boolean;
  draws: AuxiliaryDraw[];
  generators: CompositionIdentity[];
}
export const AUXILIARY_FIELDS = [
  "kind",
  "blob_index",
  "status",
  "tier",
  "vertex_count",
  "motion",
  "draws",
  "generators",
];
export function validateAuxiliary(
  value: unknown,
  blob: BlobDescriptor,
  resources: readonly string[],
): void {
  const slice = object(value, AUXILIARY_FIELDS);
  requirePlan(
    slice.kind === "auxiliary" &&
      ["unavailable", "cleared", "drawn"].includes(String(slice.status)),
    "invalid_header",
    "Invalid auxiliary outcome",
  );
  const tier = integer(slice.tier, -1, 2),
    vertices = integer(slice.vertex_count, 0, 0xffff_ffff);
  requirePlan(
    typeof slice.motion === "boolean" &&
      Array.isArray(slice.draws) &&
      slice.draws.length <= 65536 &&
      Array.isArray(slice.generators) &&
      slice.generators.length <= 65536 &&
      Array.isArray(resources),
    "invalid_header",
    "Invalid auxiliary arrays",
  );
  if (slice.status !== "drawn")
    requirePlan(
      vertices === 0 && !slice.motion && slice.draws.length === 0 && slice.generators.length === 0,
      "invalid_header",
      "Non-drawing auxiliary plans must not retain draws",
    );
  if (slice.status === "unavailable")
    requirePlan(tier === -1, "invalid_header", "Unavailable auxiliary tier");
  const hashes = new Set<string>();
  for (const value of slice.draws) {
    const draw = object(value, ["instance_id", "first_vertex", "vertex_count", "texture"]);
    compositionIdentityToString(draw.instance_id);
    const first = integer(draw.first_vertex, 0, vertices);
    integer(draw.vertex_count, 0, vertices - first);
    requirePlan(
      draw.texture !== null && typeof draw.texture === "object",
      "invalid_header",
      "Invalid auxiliary texture",
    );
    const texture = draw.texture as Record<string, unknown>;
    if (texture.kind === "none") object(texture, ["kind"]);
    else if (texture.kind === "media") {
      object(texture, ["kind", "hash"]);
      hash(texture.hash);
      hashes.add(texture.hash as string);
    } else {
      object(texture, ["kind", "instance_id"]);
      requirePlan(
        texture.kind === "surface" || texture.kind === "raster_cache",
        "invalid_header",
        "Invalid auxiliary texture role",
      );
      compositionIdentityToString(texture.instance_id);
    }
  }
  for (const id of slice.generators) compositionIdentityToString(id);
  requirePlan(
    resources.length === hashes.size && resources.every((h) => hashes.has(h)),
    "missing_resource",
    "Auxiliary media closure differs",
  );
  const bytes = Math.max(4, slice.draws.length * 8 + (slice.motion ? vertices * 8 : 0));
  requirePlan(
    blob.element_type === "u8" && blob.element_count === bytes && blob.byte_length === bytes,
    "invalid_header",
    "Invalid auxiliary payload layout",
  );
}
export function validateAuxiliaryBlob(bytes: Uint8Array, slice: AuxiliarySlice): void {
  requirePlan(
    bytes.length ===
      Math.max(4, slice.draws.length * 8 + (slice.motion ? slice.vertex_count * 8 : 0)),
    "invalid_header",
    "Invalid auxiliary payload length",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (slice.draws.length === 0 && (!slice.motion || slice.vertex_count === 0)) {
    requirePlan(
      view.getUint32(0, true) === 0,
      "invalid_header",
      "Empty auxiliary padding must be zero",
    );
    return;
  }
  for (let offset = slice.draws.length * 8; offset < bytes.length; offset += 4) {
    const value = view.getFloat32(offset, true);
    requirePlan(
      Number.isFinite(value) && Math.abs(value) <= 8,
      "invalid_header",
      "Invalid auxiliary motion displacement",
    );
  }
}
