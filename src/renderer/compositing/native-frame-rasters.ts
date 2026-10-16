import { canonicalJson, requirePlan } from "../frame-plan/canonical";
import { attachFrameMedia } from "../frame-plan/frame-bundle-media";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import { contentResourceHash, validateResourceMessage } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";
import { type CapturedMediaPixels, validateMediaPixelLayout } from "../media/media-pixel-payload";
import { VerifiedMediaPixels } from "../media/verified-media-pixels";

type RasterCapture = CapturedMediaPixels | VerifiedMediaPixels;

/** Attach owned raster captures; Rust admission validates the complete executable dependency graph. */
export async function withNativeFrameRasters(
  input: FrameBundle,
  captures:
    | readonly RasterCapture[]
    | ((frames: readonly PutResource[]) => Promise<readonly RasterCapture[]>),
): Promise<FrameBundle> {
  // Snapshot before invoking asynchronous capture; later renderer work may reuse its inputs.
  const snapshot = structuredClone(input);
  const entries = new Map(snapshot.resources.map((packet) => [packet.message.hash, packet]));
  requirePlan(
    entries.size === snapshot.resources.length,
    "invalid_resource",
    "Duplicate native resources",
  );
  const required = snapshot.resources.filter(
    (packet) =>
      packet.message.kind === "media_frame" && packet.message.descriptor.sample.kind === "raster",
  );
  const captured =
    typeof captures === "function"
      ? await captures(structuredClone(required.map((packet) => packet.message)))
      : captures;
  requirePlan(
    captured.length <= 65536 &&
      captured.reduce(
        (sum, capture) =>
          sum +
          (capture instanceof VerifiedMediaPixels
            ? VerifiedMediaPixels.byteLength(capture)
            : capture.pixels.bytes.length),
        0,
      ) <= 67108864,
    "limit_exceeded",
    "Native raster captures exceed aggregate frame budget",
  );
  const proven = new Set<CapturedMediaPixels>();
  const owned = {
    input: snapshot,
    captures: captured.map((capture) => {
      if (!(capture instanceof VerifiedMediaPixels)) return structuredClone(capture);
      const copy = VerifiedMediaPixels.copy(capture);
      proven.add(copy);
      return copy;
    }),
  };
  requirePlan(
    canonicalJson(required.map((packet) => packet.message.hash).sort()) ===
      canonicalJson(owned.captures.map((capture) => capture.frame.hash).sort()),
    "missing_resource",
    "Native raster coverage differs from declared inputs",
  );
  for (const capture of owned.captures) {
    requirePlan(
      canonicalJson(entries.get(capture.frame.hash)?.message) === canonicalJson(capture.frame),
      "invalid_resource",
      "Native raster identity differs from declared input",
    );
    validateMediaPixelLayout(capture);
    requirePlan(
      validateResourceMessage(capture.pixels.message).type === "put_resource",
      "invalid_resource",
      "Native raster pixels require a resource put",
    );
  }
  const sizes = new Map([...entries].map(([hash, packet]) => [hash, packet.bytes.length]));
  for (const capture of owned.captures)
    sizes.set(capture.pixels.message.hash, capture.pixels.bytes.length);
  requirePlan(
    sizes.size <= 65536 && [...sizes.values()].reduce((sum, size) => sum + size, 0) <= 67108864,
    "limit_exceeded",
    "Native raster resources exceed transport budget",
  );
  for (let first = 0; first < owned.captures.length; first += 32) {
    const batch = owned.captures.slice(first, first + 32);
    const verified = await Promise.allSettled(
      batch
        .filter((capture) => !proven.has(capture))
        .map(async ({ pixels }) => {
          requirePlan(
            (await contentResourceHash(pixels.message, pixels.bytes)) === pixels.message.hash,
            "hash_mismatch",
            "Surface bundle resource hash mismatch",
          );
        }),
    );
    for (const result of verified) if (result.status === "rejected") throw result.reason;
    for (const capture of batch) entries.set(capture.pixels.message.hash, capture.pixels);
  }
  requirePlan(
    entries.size <= 65536 &&
      [...entries.values()].reduce((sum, packet) => sum + packet.bytes.length, 0) <= 67108864,
    "limit_exceeded",
    "Native raster resources exceed transport budget",
  );
  return attachFrameMedia(owned.input, owned.captures, {
    resolve(hash) {
      const packet = entries.get(hash);
      requirePlan(packet, "missing_resource", "Native raster resource is absent");
      return packet;
    },
  });
}
