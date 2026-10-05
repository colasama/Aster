import { BLEND_MODES } from "../../core/types";
import { hash, integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { FrameHeaderSlice, LayerEffectSlice } from "./types";

export const LAYER_EFFECT_BYTES = 4200;
export const LAYER_EFFECT_FIELDS = [
  "kind",
  "blob_index",
  "instance_id",
  "blend_mode",
  "route",
  "operation_count",
  "uses_blur",
  "uses_glow",
  "lut_hash",
];

export function validateLayerEffect(
  value: unknown,
  descriptor: unknown,
  references: unknown,
): void {
  const slice = object(value, LAYER_EFFECT_FIELDS);
  compositionIdentityToString(slice.instance_id);
  requirePlan(
    BLEND_MODES.includes(slice.blend_mode as never),
    "invalid_layer_effect",
    "Unknown effect blend mode",
  );
  requirePlan(
    slice.route === "layer" || slice.route === "adjustment",
    "invalid_layer_effect",
    "Unknown effect route",
  );
  integer(slice.operation_count, 0, 64);
  requirePlan(
    typeof slice.uses_blur === "boolean" && typeof slice.uses_glow === "boolean",
    "invalid_layer_effect",
    "Invalid pyramid flags",
  );
  hash(slice.lut_hash);
  requirePlan(
    Array.isArray(references) && references.includes(slice.lut_hash),
    "invalid_layer_effect",
    "LUT hash is undeclared",
  );
  const blob = object(descriptor, ["byte_offset", "byte_length", "element_type", "element_count"]);
  requirePlan(
    blob.element_type === "u8" &&
      blob.byte_length === LAYER_EFFECT_BYTES &&
      blob.element_count === LAYER_EFFECT_BYTES,
    "invalid_layer_effect",
    "Invalid effect payload layout",
  );
}

export function validateLayerEffectBlob(
  bytes: Uint8Array,
  slice: LayerEffectSlice,
  header: FrameHeaderSlice,
): void {
  requirePlan(
    bytes.byteLength === LAYER_EFFECT_BYTES,
    "invalid_layer_effect",
    "Invalid effect payload length",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f32 = (index: number) => view.getFloat32(index * 4, true);
  const lod = f32(18);
  const threshold = view.getFloat64(4192, true);
  requirePlan(
    f32(0) === header.render_target.width &&
      f32(1) === header.render_target.height &&
      f32(16) === slice.operation_count &&
      f32(17) === 1 &&
      f32(19) === Number(slice.uses_glow) &&
      Number.isInteger(lod) &&
      lod >= 0 &&
      lod <= 7 &&
      Number.isFinite(threshold) &&
      threshold >= 0,
    "invalid_layer_effect",
    "Effect controls differ from metadata or bounds",
  );
}
