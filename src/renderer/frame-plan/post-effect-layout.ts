import { object, requirePlan } from "./canonical";
import type { BlobDescriptor, FrameHeaderSlice } from "./types";

export type DepthInputs = [
  "scene" | "motion_blur",
  "worldPosition",
  "worldPosition" | "transparentWorldPosition",
  "worldPosition" | "peeledWorldPosition",
  "scene" | "motion_blur" | "frontLayerColor",
  "scene" | "motion_blur" | "peeledLayerColor",
];
export type PostEffect =
  | { kind: "depth"; mode: "depthFog" | "depthOfField"; inputs: DepthInputs }
  | {
      kind: "surface";
      mode: "selectionIsolation" | "vectorMotionBlur";
      inputs: ["scene", "objectId", "motionVector"];
    };
export interface PostEffectSlice {
  kind: "post_effect";
  blob_index: number;
  status: "ready" | "skipped";
  effect: PostEffect;
}
export const POST_EFFECT_FIELDS = ["kind", "blob_index", "status", "effect"];
export function validatePostEffect(value: unknown, blob: BlobDescriptor): void {
  const slice = object(value, POST_EFFECT_FIELDS);
  requirePlan(
    slice.kind === "post_effect" && (slice.status === "ready" || slice.status === "skipped"),
    "invalid_header",
    "Invalid post effect status",
  );
  const effect = object(slice.effect, ["kind", "mode", "inputs"]);
  requirePlan(
    effect.kind === "depth" || effect.kind === "surface",
    "invalid_header",
    "Invalid post effect kind",
  );
  const depth = effect.kind === "depth";
  requirePlan(
    (depth ? ["depthFog", "depthOfField"] : ["selectionIsolation", "vectorMotionBlur"]).includes(
      String(effect.mode),
    ),
    "invalid_header",
    "Invalid post effect mode",
  );
  const roles = depth
    ? [
        ["scene", "motion_blur"],
        ["worldPosition"],
        ["worldPosition", "transparentWorldPosition"],
        ["worldPosition", "peeledWorldPosition"],
        ["scene", "motion_blur", "frontLayerColor"],
        ["scene", "motion_blur", "peeledLayerColor"],
      ]
    : [["scene"], ["objectId"], ["motionVector"]];
  requirePlan(
    Array.isArray(effect.inputs) &&
      effect.inputs.length === roles.length &&
      effect.inputs.every((v, i) => roles[i].includes(v)),
    "invalid_header",
    "Invalid post effect attachment route",
  );
  const size = depth ? 128 : 32;
  requirePlan(
    blob.element_type === "u8" && blob.element_count === size && blob.byte_length === size,
    "invalid_header",
    "Invalid post effect uniform layout",
  );
}
export function validatePostEffectBlob(
  bytes: Uint8Array,
  header: FrameHeaderSlice,
  effect: PostEffect,
): void {
  const depth = effect.kind === "depth";
  requirePlan(
    bytes.length === (depth ? 128 : 32),
    "invalid_header",
    "Invalid post effect payload length",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = (i: number) => view.getFloat32(i * 4, true);
  const mode = effect.mode === "depthFog" || effect.mode === "selectionIsolation" ? 1 : 2;
  requirePlan(
    f(0) === header.render_target.width &&
      f(1) === header.render_target.height &&
      (depth ? f(2) : view.getUint32(8, true)) === mode,
    "invalid_header",
    "Post effect viewport or mode differs from the plan",
  );
  if (!depth) {
    requirePlan(
      Number.isFinite(f(4)) &&
        f(4) >= 0 &&
        f(4) <= 4 &&
        [20, 24, 28].every((offset) => view.getUint32(offset, true) === 0),
      "invalid_header",
      "Invalid surface controls",
    );
    return;
  }
  const ranges: [number, number, number][] = [
    [3, 8, 64],
    [4, 0, 16],
    [5, 0, 16],
    [6, 0, 16],
    [7, 0, 1],
    [11, 0, 100000],
    [15, Math.fround(0.001), 10000000],
    [16, 0, 10000000],
    [17, 0, 10000],
    [18, 0, 2],
    [19, Math.fround(0.001), 10000000],
    [20, 0, 10],
    [21, 0, 10],
    [22, 0, 10],
    [23, 0, 256],
    [24, 1, 10],
    [25, -Math.fround(2 * Math.PI), Math.fround(2 * Math.PI)],
    [26, 0, 1],
    [27, 1, 100],
    [28, 0, 1],
    [29, 0, 1],
    [30, 0, 1],
    [31, 0, 1],
  ];
  requirePlan(
    Array.from({ length: 32 }, (_, i) => f(i)).every(Number.isFinite) &&
      ranges.every(([i, min, max]) => f(i) >= min && f(i) <= max),
    "invalid_header",
    "Invalid depth controls",
  );
}
