import { hash, integer, object, requirePlan, validUnicode } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import { type RasterSample, readRasterBounds } from "./raster-sample";
import { validateFrameTime } from "./time";
import type { CompositionIdentity, FrameTime } from "./types";

/** Authorization is resolved by the job broker; this descriptor grants no file access. */
export interface MediaSourceDescriptor {
  source_id: CompositionIdentity;
  content_identity: string;
  authorization_scope: string;
  media_kind: "image" | "sequence" | "video" | "raster";
}

export type MediaSample =
  | { kind: "image" }
  | { kind: "sequence"; frame: number; file_identity: string }
  | { kind: "video"; requested_time: FrameTime; uploaded_time: FrameTime }
  | RasterSample;

export interface MediaFrameDescriptor {
  source: string;
  sample: MediaSample;
  width: number;
  height: number;
  format: "rgba8unorm-srgb";
}

export function validateMediaSource(value: unknown): MediaSourceDescriptor {
  const source = object(value, [
    "source_id",
    "content_identity",
    "authorization_scope",
    "media_kind",
  ]);
  compositionIdentityToString(source.source_id);
  for (const text of [source.content_identity, source.authorization_scope])
    requirePlan(
      typeof text === "string" && text.length > 0 && validUnicode(text),
      "invalid_resource",
      "Media source identity must be nonempty Unicode",
    );
  requirePlan(
    ["image", "sequence", "video", "raster"].includes(source.media_kind as string),
    "invalid_resource",
    "Unknown media source kind",
  );
  return source as unknown as MediaSourceDescriptor;
}

export function validateMediaFrame(value: unknown): MediaFrameDescriptor {
  const frame = object(value, ["source", "sample", "width", "height", "format"]);
  hash(frame.source);
  integer(frame.width, 1, 16384);
  integer(frame.height, 1, 16384);
  requirePlan(
    frame.format === "rgba8unorm-srgb",
    "invalid_resource",
    "Unsupported media texture format",
  );
  const sample = frame.sample as Record<string, unknown> | null;
  requirePlan(
    sample !== null && typeof sample === "object",
    "invalid_resource",
    "Missing media sample",
  );
  if (sample.kind === "image") object(sample, ["kind"]);
  else if (sample.kind === "raster") readRasterBounds(sample);
  else if (sample.kind === "sequence") {
    object(sample, ["kind", "frame", "file_identity"]);
    requirePlan(
      typeof sample.file_identity === "string" &&
        sample.file_identity.length > 0 &&
        validUnicode(sample.file_identity),
      "invalid_resource",
      "Missing sequence member identity",
    );
    integer(sample.frame, -Number.MAX_SAFE_INTEGER);
  } else {
    requirePlan(sample.kind === "video", "invalid_resource", "Unknown media sample kind");
    object(sample, ["kind", "requested_time", "uploaded_time"]);
    validateFrameTime(sample.requested_time);
    validateFrameTime(sample.uploaded_time);
  }
  return frame as unknown as MediaFrameDescriptor;
}
