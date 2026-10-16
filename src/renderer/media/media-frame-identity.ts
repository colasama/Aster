import { sha256 } from "@noble/hashes/sha2.js";
import type { FootageSource } from "../../core/types";
import { copyWireValue, sameCanonicalValue } from "../frame-plan/canonical";
import { compositionIdentityFromString } from "../frame-plan/composition-identity";
import type {
  MediaFrameDescriptor,
  MediaSample,
  MediaSourceDescriptor,
} from "../frame-plan/media-descriptors";
import { type RasterBounds, type RasterSample, rasterSample } from "../frame-plan/raster-sample";
import { contentResourceHashSync } from "../frame-plan/resources";
import { frameTimeFromNumber } from "../frame-plan/time";
import { FramePlanError, type PutResource, type ResourceContent } from "../frame-plan/types";
import type { MediaResource } from "./media-resource";

export interface PreparedMediaIdentity {
  source: Omit<MediaSourceDescriptor, "authorization_scope">;
  sample: Exclude<MediaSample, { kind: "video" }>;
}

// One source/frame pair per live owner; returned messages never expose this verified snapshot.
const identities = new WeakMap<MediaResource, [PutResource, PutResource]>();

export function preparedMediaIdentity(
  footage: FootageSource,
  mediaKind: MediaSourceDescriptor["media_kind"],
  sample: PreparedMediaIdentity["sample"] = { kind: "image" },
  variant?: string,
): PreparedMediaIdentity {
  return {
    source: {
      source_id: compositionIdentityFromString(footage.id),
      content_identity: variant
        ? JSON.stringify([footage.contentIdentity, variant])
        : footage.contentIdentity,
      media_kind: mediaKind,
    },
    sample,
  };
}

export function preparedRasterIdentity(
  sourceId: string,
  origin: RasterSample["origin"],
  generation: string,
  bounds: RasterBounds,
): PreparedMediaIdentity {
  const sample = rasterSample(origin, bounds);
  return {
    source: {
      source_id: compositionIdentityFromString(sourceId),
      content_identity: JSON.stringify([generation, sample.bounds_f64_le]),
      media_kind: "raster",
    },
    sample,
  };
}

/** Hashes only the locator when legacy sequence members have no verified byte identity. */
export function sequenceMemberIdentity(file: { byteIdentity?: string; url: string }): string {
  if (file.byteIdentity) return file.byteIdentity;
  return `locator-sha256:${Array.from(sha256(new TextEncoder().encode(file.url)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function mediaFrameMessages(
  resource: MediaResource,
  scope: string,
  requestedTime?: number,
): [PutResource, PutResource] {
  const identity = resource.mediaIdentity;
  if (!identity || !resource.textureWidth || !resource.textureHeight)
    throw new FramePlanError(
      "missing_resource",
      "Bound media lacks prepared identity or texture extent",
    );
  let source: MediaSourceDescriptor = { ...identity.source, authorization_scope: scope };
  let sample: MediaSample = identity.sample;
  if (resource.kind === "video") {
    if (resource.nativeVideoPlan) {
      if (
        requestedTime === undefined ||
        !Number.isFinite(requestedTime) ||
        resource.lastUploadedTime === undefined
      )
        throw new FramePlanError("missing_resource", "Native video target time is missing");
      sample = {
        kind: "video",
        requested_time: frameTimeFromNumber(requestedTime),
        uploaded_time: frameTimeFromNumber(resource.lastUploadedTime),
      };
    } else if (resource.lastUploadedTime === undefined) {
      // WebGPU initializes a newly allocated texture to transparent black before the first upload.
      source = {
        source_id: "aster:builtin-transparent",
        content_identity: "rgba8:0,0,0,0",
        authorization_scope: scope,
        media_kind: "image",
      };
      sample = { kind: "image" };
    } else {
      if (requestedTime === undefined)
        throw new FramePlanError("missing_resource", "Video target time is missing");
      sample = {
        kind: "video",
        requested_time: frameTimeFromNumber(requestedTime),
        uploaded_time: frameTimeFromNumber(resource.lastUploadedTime),
      };
    }
  }
  const sourceContent = { kind: "media_source" as const, descriptor: source };
  const previous = identities.get(resource);
  const sourceMessage: PutResource =
    previous?.[0].kind === "media_source" && sameCanonicalValue(source, previous[0].descriptor)
      ? previous[0]
      : ownedMediaMessage(sourceContent);
  const descriptor: MediaFrameDescriptor = {
    source: sourceMessage.hash,
    sample,
    width: resource.textureWidth,
    height: resource.textureHeight,
    format: "rgba8unorm-srgb",
  };
  const frameContent = { kind: "media_frame" as const, descriptor };
  const messages: [PutResource, PutResource] = [
    sourceMessage,
    previous?.[1].kind === "media_frame" && sameCanonicalValue(descriptor, previous[1].descriptor)
      ? previous[1]
      : ownedMediaMessage(frameContent),
  ];
  identities.set(resource, messages);
  return copyWireValue(messages);
}

/** Snapshot only cache misses; nested source identities and sample arrays remain privately owned. */
function ownedMediaMessage(content: ResourceContent): PutResource {
  const owned = structuredClone(content);
  return { type: "put_resource", ...owned, hash: contentResourceHashSync(owned) };
}
