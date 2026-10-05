import { withFrameBundleMediaAsync } from "../frame-plan/frame-bundle-media";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import { readFrameBundle } from "../frame-plan/frame-bundle-read";
import type { FramePlanSliceData } from "../frame-plan/types";
import type { MediaBindingLease } from "../media/media-binding-lease";
import { captureMediaPixels } from "../media/media-pixel-capture";

export interface CapturedFrameBundle extends FrameBundle {
  submittedPlan: FramePlanSliceData;
}

/** Called after queue submission, before the producer releases its media generation. */
export async function captureSubmittedFrameBundle(
  device: GPUDevice,
  input: FrameBundle,
  media: MediaBindingLease,
): Promise<CapturedFrameBundle> {
  const bundle = structuredClone(input);
  const { mediaFrames } = readFrameBundle(bundle);
  const lease = media.retainForCapture(mediaFrames.map((frame) => frame.hash));
  try {
    const pixels = await captureMediaPixels(device, lease, mediaFrames);
    return { ...(await withFrameBundleMediaAsync(bundle, pixels)), submittedPlan: bundle.plan };
  } finally {
    lease.release();
  }
}
