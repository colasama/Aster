import {
  type CapturedMediaPixels,
  validateMediaPixelLayout,
  validateMediaPixelPayload,
} from "../media/media-pixel-payload";
import { canonicalJson, requirePlan } from "./canonical";
import type { FrameBundle } from "./frame-bundle-plan";
import { readFrameBundle, readFrameBundleAsync } from "./frame-bundle-read";
import { PrecompositionBundleResources } from "./precomposition-bundle-resources";

/** Attach exact installed pixels to an already submitted bundle without reevaluating its scene. */
export function withFrameBundleMedia(
  input: FrameBundle,
  captures: readonly CapturedMediaPixels[],
): FrameBundle {
  const decoded = readFrameBundle(input);
  const required = decoded.mediaFrames.map((frame) => frame.hash).sort();
  requirePlan(
    canonicalJson(captures.map((capture) => capture.frame.hash).sort()) === canonicalJson(required),
    "missing_resource",
    "Frame media pixel coverage differs from submitted dependencies",
  );
  const resources = new PrecompositionBundleResources();
  for (const packet of input.resources) resources.add(packet);
  for (const capture of captures) {
    validateMediaPixelPayload(capture);
    resources.add(capture.pixels);
  }
  const result = attachFrameMedia(input, captures, resources);
  readFrameBundle(result);
  return result;
}

export async function withFrameBundleMediaAsync(
  input: FrameBundle,
  captures: readonly CapturedMediaPixels[],
): Promise<FrameBundle> {
  const owned = structuredClone({ input, captures });
  const decoded = await readFrameBundleAsync(owned.input);
  requirePlan(
    canonicalJson(owned.captures.map((c) => c.frame.hash).sort()) ===
      canonicalJson(decoded.mediaFrames.map((f) => f.hash).sort()),
    "missing_resource",
    "Frame media pixel coverage differs from submitted dependencies",
  );
  const resources = new PrecompositionBundleResources();
  for (const packet of owned.input.resources) await resources.addAsync(packet);
  for (const capture of owned.captures) {
    validateMediaPixelLayout(capture);
    await resources.addAsync({ message: capture.frame, bytes: new Uint8Array() });
    await resources.addAsync(capture.pixels);
  }
  const result = attachFrameMedia(owned.input, owned.captures, resources);
  await readFrameBundleAsync(result);
  return result;
}

function attachFrameMedia(
  input: FrameBundle,
  captures: readonly CapturedMediaPixels[],
  resources: PrecompositionBundleResources,
): FrameBundle {
  const plan = structuredClone(input.plan);
  const bundle = plan.metadata.slices[0];
  requirePlan(bundle.kind === "frame_bundle", "invalid_header", "Expected frame bundle");
  requirePlan(
    bundle.media_pixels.length === 0,
    "invalid_resource",
    "Frame media pixels are already captured",
  );
  bundle.media_pixels = captures
    .map((capture) => {
      return {
        frame: capture.frame.hash,
        pixels: resources.resolve(capture.pixels.message.hash).message.hash,
      };
    })
    .sort((a, b) => a.frame.localeCompare(b.frame));
  plan.metadata.resources = [
    ...new Set([...plan.metadata.resources, ...bundle.media_pixels.map((link) => link.pixels)]),
  ].sort();
  const counts = plan.blobs[0];
  new DataView(counts.buffer, counts.byteOffset, counts.byteLength).setUint32(
    16,
    bundle.media_pixels.length,
    true,
  );
  const result = {
    plan,
    resources: plan.metadata.resources.map((hash) => resources.resolve(hash)),
  };
  return result;
}
