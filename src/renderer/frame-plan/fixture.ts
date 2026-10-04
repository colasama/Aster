import { gcd, integer, requirePlan } from "./canonical";
import { encodeFramePlan } from "./codec";
import { buildRootPostUniformPlan, postUniformBytes } from "./root-post-plan";
import type { FrameHeaderSlice, FramePlanSliceV1, RationalFrameRate, RationalTime } from "./types";

export function frameIndexTime(frame: number, rate: RationalFrameRate): RationalTime {
  integer(frame, -Number.MAX_SAFE_INTEGER);
  integer(rate.numerator, 1, 0xffff_ffff);
  integer(rate.denominator, 1, 0xffff_ffff);
  const value = BigInt(frame) * BigInt(rate.denominator);
  const divisor = gcd(value, BigInt(rate.numerator));
  const reduced = value / divisor;
  requirePlan(
    reduced >= -BigInt(Number.MAX_SAFE_INTEGER) && reduced <= BigInt(Number.MAX_SAFE_INTEGER),
    "arithmetic_overflow",
    "Frame time cannot be represented exactly",
  );
  return {
    kind: "rational",
    value: Number(reduced),
    scale: Number(BigInt(rate.numerator) / divisor),
  };
}

export function uniformSliceMetadata(
  header: FrameHeaderSlice,
  count = 1,
  resources: string[] = [],
): FramePlanSliceV1 {
  integer(count, 1, 4096);
  return {
    kind: "frame_plan_slice",
    plan_version: 1,
    contract_level: "post_uniforms_slice_v1",
    renderer_plan_complete: false,
    header,
    blobs: Array.from({ length: count }, (_, index) => ({
      byte_offset: index * 96,
      byte_length: 96,
      element_type: "f32_le",
      element_count: 24,
    })),
    slices: Array.from({ length: count }, (_, blob_index) => ({
      kind: "post_process_uniforms",
      blob_index,
    })),
    resources: [...resources],
  };
}

export function productionUniformFixtures(): { id: string; bytes: Uint8Array }[] {
  return [
    { id: "zero", frame: 0, rate: { numerator: 24, denominator: 1 }, count: 1, aa: "off" as const },
    {
      id: "fractional",
      frame: 137,
      rate: { numerator: 24_000, denominator: 1001 },
      count: 2,
      aa: "ssaa2x" as const,
    },
    {
      id: "negative",
      frame: -43,
      rate: { numerator: 30_000, denominator: 1001 },
      count: 1,
      aa: "fxaa" as const,
    },
  ].map(({ id, frame, rate, count, aa }) => {
    const time = frameIndexTime(frame, rate);
    const render_target =
      aa === "ssaa2x" ? { width: 640, height: 360 } : { width: 320, height: 180 };
    const header: FrameHeaderSlice = {
      snapshot_scope: `transport-fixture:${id}`,
      project_revision: id === "negative" ? Number.MAX_SAFE_INTEGER : 7,
      composition_id: `Wire ${id} "\\\n中文🎞`,
      time,
      frame_rate: { kind: "rational", ...rate },
      target: { width: 320, height: 180 },
      render_target,
      aa,
      color_pipeline: "linear-hdr-to-srgb-display",
    };
    const blobs = Array.from({ length: count }, (_, index) => {
      const bytes = postUniformBytes(
        render_target.width,
        render_target.height,
        time.value / time.scale + index,
      );
      if (id === "negative") new DataView(bytes.buffer).setFloat32(12, -0, true);
      return bytes;
    });
    return { id, bytes: encodeFramePlan(uniformSliceMetadata(header, count), blobs) };
  });
}

/** Real local producer output also crosses the independent Rust codec boundary. */
export function rootPostPlanFixtures(): {
  id: string;
  bytes: Uint8Array;
  time: number;
  compositionId: string;
}[] {
  return [
    { id: "negative-zero", time: -0 },
    { id: "min-subnormal", time: Number.MIN_VALUE },
    { id: "max-finite", time: Number.MAX_VALUE },
    { id: "f32-underflow", time: -1e-100 },
    { id: "f32-overflow", time: -1e100 },
    {
      id: "fractional-rate-request-seek",
      time: (137 * 1001) / 24000,
      frameRate: { numerator: 24000, denominator: 1001 },
    },
    { id: "binary-ratio", time: 0.1, frameRate: { numerator: 29.97, denominator: 1 } },
    { id: "reduced-rate", time: -1 / 3, frameRate: { numerator: 48000, denominator: 2002 } },
    {
      id: "extreme-binary-ratio",
      time: 1,
      frameRate: { numerator: Number.MIN_VALUE, denominator: Number.MAX_VALUE },
    },
    { id: "long-identity", time: 1, compositionId: `${"a".repeat(257)}${"中文".repeat(50)}` },
    { id: "nul-identity", time: 1, compositionId: "root\0composition" },
    { id: "utf16-identity", time: 1, compositionId: "root:\ud800:tail:\udc00" },
  ].map(({ id, time, frameRate, compositionId = "root-post-process" }) => {
    const plan = buildRootPostUniformPlan({
      snapshot: { snapshotScope: `root-fixture:${id}`, projectRevision: 9 },
      compositionId,
      time,
      frameRate: frameRate ?? { numerator: 30, denominator: 1 },
      target: { width: 320, height: 180 },
      renderTarget: { width: 640, height: 360 },
      antiAliasing: "ssaa2x",
    });
    return { id, time, compositionId, bytes: encodeFramePlan(plan.metadata, plan.blobs) };
  });
}
