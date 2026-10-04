import type { TextMotionBlurSample } from "./text-motion-blur-plan";
import type { TextRasterBounds } from "./text-raster-bounds";
import type { RasterizedText } from "./text-rasterizer";

export const TEXT_MOTION_BLUR_WEIGHT_STRIDE = 256;

export interface TextMotionBlurRasterScalePlan {
  requestedScale: number;
  resolutionScale: number;
  width: number;
  height: number;
  pixelBytes: number;
  minimumSampleCount: number;
  requiredTransientBytes: number;
  reduced: boolean;
}

export interface TemporalTextRasterPlan {
  sourceId: string;
  label: string;
  source: string;
  boundsSource: string;
  bounds: TextRasterBounds;
  scale: TextMotionBlurRasterScalePlan;
  samples: TextMotionBlurSample[];
}

export interface AcquiredTemporalTextRaster extends TemporalTextRasterPlan {
  rasters: RasterizedText[];
}
