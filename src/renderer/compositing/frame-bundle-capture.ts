import { withFrameBundleMediaAsync } from "../frame-plan/frame-bundle-media";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import { readFrameBundle } from "../frame-plan/frame-bundle-read";
import type { FramePlanSliceData } from "../frame-plan/types";
import type { MediaBindingLease } from "../media/media-binding-lease";
import { captureMediaPixels } from "../media/media-pixel-capture";
import type { NativeRasterCaptureCache } from "../media/native-raster-capture-cache";
import { withNativeFrameRasters } from "./native-frame-rasters";

export interface CapturedFrameBundle extends FrameBundle {
  submittedPlan: FramePlanSliceData;
}

/** Called after queue submission, before the producer releases its media generation. */
export async function captureSubmittedFrameBundle(
  device: GPUDevice,
  input: FrameBundle,
  media: MediaBindingLease,
  coverage: "all" | "raster" = "all",
  rasters?: NativeRasterCaptureCache,
): Promise<CapturedFrameBundle> {
  if (coverage === "raster") {
    const submittedPlan = structuredClone(input.plan);
    const bundle = await withNativeFrameRasters(input, async (selected) => {
      const lease = media.retainForCapture(selected.map((frame) => frame.hash));
      try {
        return await (rasters
          ? rasters.captureVerified(device, lease, selected)
          : captureMediaPixels(device, lease, selected));
      } finally {
        lease.release();
      }
    });
    return { ...bundle, submittedPlan };
  }
  const bundle = structuredClone(input);
  const selected = readFrameBundle(bundle).mediaFrames;
  const lease = media.retainForCapture(selected.map((frame) => frame.hash));
  try {
    const pixels = await captureMediaPixels(device, lease, selected);
    return {
      ...(await withFrameBundleMediaAsync(bundle, pixels, coverage)),
      submittedPlan: bundle.plan,
    };
  } finally {
    lease.release();
  }
}
