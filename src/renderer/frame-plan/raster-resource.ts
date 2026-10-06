import { requirePlan } from "./canonical";
import { readRasterBounds } from "./raster-sample";
import {
  contentResourceHash,
  type FrameResourceRegistry,
  validateResourceContent,
} from "./resources";
import type { PutResource } from "./types";

/** Own the input before hashing so a caller cannot mutate accepted pixel generations. */
export async function createRasterPixels(frame: PutResource, input: Uint8Array) {
  requirePlan(
    frame.kind === "media_frame" &&
      frame.descriptor.sample.kind === "raster" &&
      frame.descriptor.format === "rgba8unorm-srgb",
    "invalid_resource",
    "Pixel resources require a raster frame",
  );
  const content = {
    kind: "raster_pixels" as const,
    descriptor: {
      frame: frame.hash,
      width: frame.descriptor.width,
      height: frame.descriptor.height,
      format: frame.descriptor.format,
    },
  };
  validateResourceContent(content, input);
  const bytes = new Uint8Array(input);
  const message: PutResource = {
    type: "put_resource",
    ...content,
    hash: await contentResourceHash(content, bytes),
  };
  return { message, bytes };
}

/** Resolve a complete supplied raster without invoking any source evaluator or decoder. */
export function decodeRasterPixels(
  registry: FrameResourceRegistry,
  pixelHash: string,
  scope: string,
) {
  const pixels = registry.resolve(pixelHash);
  requirePlan(
    pixels.content.kind === "raster_pixels",
    "invalid_resource",
    "Expected raster pixels",
  );
  const frameHash = pixels.content.descriptor.frame;
  const frame = registry.resolve(frameHash).content;
  requirePlan(
    frame.kind === "media_frame" && frame.descriptor.sample.kind === "raster",
    "invalid_resource",
    "Expected raster frame",
  );
  const sourceHash = frame.descriptor.source;
  const source = registry.resolve(sourceHash).content;
  requirePlan(
    source.kind === "media_source" && source.descriptor.authorization_scope === scope,
    "resource_conflict",
    "Raster source is outside the requested scope",
  );
  const { authorization_scope: _scope, ...identity } = source.descriptor;
  return {
    frameHash,
    messages: [
      { type: "put_resource", hash: sourceHash, ...source },
      { type: "put_resource", hash: frameHash, ...frame },
    ] as PutResource[],
    identity: { source: identity, sample: frame.descriptor.sample },
    bounds: readRasterBounds(frame.descriptor.sample),
    width: frame.descriptor.width,
    height: frame.descriptor.height,
    bytes: pixels.bytes,
  };
}
