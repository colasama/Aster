import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { antiAliasingScale } from "../src/core/rendering/anti-aliasing.js";
import type { RenderJobManifest } from "../src/core/rendering/render-queue.js";
import type { NativeSessionReply } from "./native-render-protocol.js";

export function nativeCompositionIdentity(value: string): string | { utf16_units: number[] } {
  return /[\uD800-\uDFFF]/u.test(value)
    ? { utf16_units: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)) }
    : value;
}

/** Bind Rust's validated header and plan digest to the immutable queue assignment. */
export function validateNativeJobFrame(
  manifest: RenderJobManifest,
  index: number,
  plan: Uint8Array,
  reply: NativeSessionReply,
  phase: "admission" | "warmup" = "admission",
): void {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= manifest.endFrameExclusive - manifest.startFrame
  )
    throw new Error("Native frame index is outside the immutable job");
  const encoded = reply.response.type === "encoded";
  const warming = phase === "warmup";
  const response =
    encoded || warming
      ? (reply.response.frame as Record<string, unknown> | undefined)
      : reply.response;
  if (
    (warming
      ? reply.response.type !== "frame_warmed"
      : encoded
        ? reply.response.submitted_frame !== index || reply.response.complete !== false
        : response?.type !== "frame_checked") ||
    response?.plan_sha256 !== createHash("sha256").update(plan).digest("hex")
  )
    throw new Error("Native admission did not authenticate the supplied plan");
  const header = response.header as Record<string, unknown> | undefined;
  const time = header?.time as Record<string, unknown> | undefined;
  const requestedTime =
    ((manifest.startFrame + index) * manifest.frameRate.denominator) / manifest.frameRate.numerator;
  // Queued frames are nonnegative ordinary finite seconds, so this exact binary reconstruction
  // does not need decimal parsing or a rounding tolerance. Rust validates canonical wire form.
  if (
    time?.kind !== "binary_rational" ||
    time.negative !== false ||
    !Number.isSafeInteger(time.significand) ||
    !Number.isSafeInteger(time.exponent) ||
    !Object.is(Number(time.significand) * 2 ** Number(time.exponent), requestedTime)
  )
    throw new Error("Native frame time does not match the immutable job");
  let divisor = manifest.frameRate.numerator,
    remainder = manifest.frameRate.denominator;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  const aa = manifest.antiAliasing ?? "off";
  const scale = antiAliasingScale(aa);
  const expected = {
    snapshot_scope: `render-job:${manifest.id}`,
    project_revision: manifest.projectRevision,
    composition_id: nativeCompositionIdentity(manifest.compositionId),
    time,
    frame_rate: {
      kind: "rational",
      numerator: manifest.frameRate.numerator / divisor,
      denominator: manifest.frameRate.denominator / divisor,
    },
    target: { width: manifest.width, height: manifest.height },
    render_target: { width: manifest.width * scale, height: manifest.height * scale },
    aa,
    color_pipeline: "linear-hdr-to-srgb-display",
  };
  if (!isDeepStrictEqual(header, expected))
    throw new Error("Native frame header does not match the immutable job");
}
