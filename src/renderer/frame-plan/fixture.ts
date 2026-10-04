import { buildPostProcessUniforms } from "../effects/post-process";
import { gcd, integer, requirePlan } from "./canonical";
import { encodeFramePlan } from "./codec";
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
  return { value: Number(reduced), scale: Number(BigInt(rate.numerator) / divisor) };
}

/** Writes existing production uniform values in explicit little-endian order. No renderer executes here. */
export function postUniformBytes(width: number, height: number, time: number): Uint8Array {
  const uniforms = buildPostProcessUniforms(width, height, time);
  const bytes = new Uint8Array(uniforms.byteLength);
  const view = new DataView(bytes.buffer);
  uniforms.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
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
      project_revision: id === "negative" ? Number.MAX_SAFE_INTEGER : 7,
      composition_id: `Wire ${id} "\\\n中文🎞`,
      time,
      frame_rate: rate,
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
