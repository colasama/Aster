import { resolve } from "node:path";

export interface NativeProjectExportExpectation {
  format: "mp4" | "png" | "png-sequence";
  projectSha256: string;
  output: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  startFrame: number;
  frames: number;
  bitrate: number;
  includeAudio: boolean;
}

export interface NativeProjectExportProgress {
  stage: "audio" | "encoder" | "render";
  rendered_frames: number;
  total_frames: number;
  elapsed_ms: number;
}

export interface NativeProjectImageReceipt {
  index: number;
  member: string | null;
  time: number;
  time_bits: string;
  rgba_sha256: string;
  png_sha256: string;
  bytes: number;
}

export interface NativeProjectExportReceipt {
  schema_version: 1;
  status: "passed";
  project: { authored_sha256: string; runtime_sha256: string };
  report: { frames: number; elapsed_ms: number; output_bytes?: number; audio_frames?: number };
  images?: NativeProjectImageReceipt[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native export protocol object");
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateNativeProjectExpectation(value: NativeProjectExportExpectation): void {
  if (
    !["mp4", "png", "png-sequence"].includes(value.format) ||
    !hash(value.projectSha256) ||
    !value.output ||
    value.output.includes("\0") ||
    !integer(value.width, 1) ||
    !integer(value.height, 1) ||
    !integer(value.frameRate.numerator, 1) ||
    !integer(value.frameRate.denominator, 1) ||
    !integer(value.startFrame) ||
    !integer(value.frames, 1) ||
    !integer(value.startFrame + value.frames) ||
    !integer(value.bitrate, 1) ||
    (value.format === "png" && value.frames !== 1)
  )
    throw new Error("Invalid native export expectation");
}

export function parseNativeProjectProgress(
  value: unknown,
  expected: NativeProjectExportExpectation,
): NativeProjectExportProgress {
  const row = record(value);
  if (
    !["audio", "encoder", "render"].includes(String(row.stage)) ||
    !integer(row.rendered_frames) ||
    row.rendered_frames > expected.frames ||
    row.total_frames !== expected.frames ||
    !integer(row.elapsed_ms) ||
    (row.stage !== "render" && row.rendered_frames !== 0)
  )
    throw new Error("Native export progress differs from its job");
  return row as unknown as NativeProjectExportProgress;
}

/** A successful exit alone cannot authorize queue publication. */
export function parseNativeProjectReceipt(
  value: unknown,
  expected: NativeProjectExportExpectation,
): NativeProjectExportReceipt {
  const row = record(value),
    project = record(row.project),
    report = record(row.report);
  const video = expected.format === "mp4" ? record(row.video) : row;
  const size = record(video.size),
    rate = record(video.frame_rate);
  const output = expected.format === "mp4" ? report.output : row.output;
  if (
    row.schema_version !== 1 ||
    row.status !== "passed" ||
    project.authored_sha256 !== expected.projectSha256 ||
    !hash(project.runtime_sha256) ||
    report.frames !== expected.frames ||
    !integer(report.elapsed_ms) ||
    size.width !== expected.width ||
    size.height !== expected.height ||
    rate.numerator !== expected.frameRate.numerator ||
    rate.denominator !== expected.frameRate.denominator ||
    typeof output !== "string" ||
    resolve(output) !== resolve(expected.output)
  )
    throw new Error("Native export receipt differs from its immutable job");
  if (expected.format === "mp4") {
    const encoder = record(report.encoder);
    if (
      video.bitrate_bps !== expected.bitrate ||
      !integer(report.output_bytes, 1) ||
      !integer(report.audio_frames) ||
      (!expected.includeAudio && report.audio_frames !== 0) ||
      encoder.accepted_frames !== expected.frames ||
      encoder.encoded_frames !== expected.frames ||
      encoder.drain_completed !== true ||
      encoder.cancelled !== false
    )
      throw new Error("Native encoder did not complete the requested output");
  } else {
    if (
      row.format !== expected.format ||
      !Array.isArray(row.images) ||
      row.images.length !== expected.frames
    )
      throw new Error("Native image output is incomplete");
    for (const [index, value] of row.images.entries()) {
      const image = record(value);
      const time =
        ((expected.startFrame + index) * expected.frameRate.denominator) /
        expected.frameRate.numerator;
      const bits = Buffer.alloc(8);
      bits.writeDoubleBE(time);
      const member =
        expected.format === "png" ? null : `frame_${String(index).padStart(6, "0")}.png`;
      if (
        image.index !== index ||
        image.member !== member ||
        image.time !== time ||
        image.time_bits !== bits.toString("hex") ||
        !hash(image.rgba_sha256) ||
        !hash(image.png_sha256) ||
        !integer(image.bytes, 1)
      )
        throw new Error("Native image receipt has a different frame identity");
    }
  }
  return row as unknown as NativeProjectExportReceipt;
}
