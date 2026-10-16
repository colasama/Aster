import type { NativeFramePacket } from "../../core/rendering/native-export-protocol";
import { canonicalJson, requirePlan, sameCanonicalValue } from "../frame-plan/canonical";
import { encodeFramePlan } from "../frame-plan/codec";
import { attachFrameMedia } from "../frame-plan/frame-bundle-media";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import { VerifiedMediaPixels } from "../media/verified-media-pixels";

/** Transfer raster inputs and file-media identities; the native worker owns file decoding. */
export function nativeFramePacket(
  bundle: FrameBundle,
  retained?: ReadonlySet<string>,
): NativeFramePacket {
  return emitPacket(bundle, retained);
}

/** Copy only newly transferred pixels, with full logical budgets and private cache ownership. */
export function nativeFramePacketWithRasters(
  input: FrameBundle,
  captures: readonly VerifiedMediaPixels[],
  retained?: ReadonlySet<string>,
): NativeFramePacket {
  const entries = new Map(input.resources.map((resource) => [resource.message.hash, resource]));
  requirePlan(
    entries.size === input.resources.length,
    "invalid_resource",
    "Duplicate native resources",
  );
  requirePlan(
    captures.length <= 65536 &&
      captures.reduce((sum, capture) => sum + VerifiedMediaPixels.byteLength(capture), 0) <=
        67108864,
    "limit_exceeded",
    "Native raster captures exceed aggregate frame budget",
  );
  const described = captures.map(VerifiedMediaPixels.describe);
  const required = input.resources.filter(
    (resource) =>
      resource.message.kind === "media_frame" &&
      resource.message.descriptor.sample.kind === "raster",
  );
  requirePlan(
    canonicalJson(required.map((resource) => resource.message.hash).sort()) ===
      canonicalJson(described.map((capture) => capture.frame.hash).sort()),
    "missing_resource",
    "Native raster coverage differs from declared inputs",
  );
  const proofs = new Map<string, VerifiedMediaPixels>();
  const sizes = new Map(
    input.resources.map((resource) => [resource.message.hash, resource.bytes.length]),
  );
  for (const [index, description] of described.entries()) {
    requirePlan(
      sameCanonicalValue(entries.get(description.frame.hash)?.message, description.frame),
      "invalid_resource",
      "Native raster identity differs from declared input",
    );
    const hash = description.pixels.message.hash;
    proofs.set(hash, captures[index]);
    sizes.set(hash, VerifiedMediaPixels.byteLength(captures[index]));
    // Only this synchronous assembly sees placeholders. The final packet owns real bytes or references.
    entries.set(hash, { message: description.pixels.message, bytes: new Uint8Array() });
  }
  requirePlan(
    sizes.size <= 65536 && [...sizes.values()].reduce((sum, size) => sum + size, 0) <= 67108864,
    "limit_exceeded",
    "Native raster resources exceed transport budget",
  );
  const bundle = attachFrameMedia(input, described, {
    resolve(hash) {
      const resource = entries.get(hash);
      requirePlan(resource, "missing_resource", "Native raster resource is absent");
      return resource;
    },
  });
  return emitPacket(bundle, retained, proofs);
}

function emitPacket(
  bundle: FrameBundle,
  retained?: ReadonlySet<string>,
  proofs?: ReadonlyMap<string, VerifiedMediaPixels>,
): NativeFramePacket {
  const plan = encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs);
  const bytes = bundle.resources.reduce((sum, resource) => {
    const proof = proofs?.get(resource.message.hash);
    return sum + (proof ? VerifiedMediaPixels.byteLength(proof) : resource.bytes.length);
  }, plan.length);
  if (bytes > 64 * 1024 * 1024 || bundle.resources.length > 65536)
    throw new Error("Native export frame exceeds transport budget");
  const root = bundle.plan.metadata.slices[0];
  if (root.kind !== "frame_bundle") throw new Error("Native export requires a frame bundle");
  const resources = new Map(bundle.resources.map((resource) => [resource.message.hash, resource]));
  if (
    root.media_pixels.some((link) => {
      const frame = resources.get(link.frame)?.message;
      return frame?.kind !== "media_frame" || frame.descriptor.sample.kind !== "raster";
    })
  )
    throw new Error("Native export cannot accept captured file-media pixels");
  return {
    plan: Uint8Array.from(plan).buffer,
    resources: bundle.resources
      .filter((resource) => !retained?.has(resource.message.hash))
      .map((resource) => {
        const proof = proofs?.get(resource.message.hash);
        const owned = proof
          ? VerifiedMediaPixels.copyResource(proof)
          : {
              message: structuredClone(resource.message),
              bytes: new Uint8Array(resource.bytes),
            };
        return { message: owned.message, bytes: owned.bytes.buffer };
      }),
    ...(retained?.size
      ? {
          retainedResources: bundle.resources
            .filter((resource) => retained.has(resource.message.hash))
            .map((resource) => resource.message.hash),
        }
      : {}),
  };
}
