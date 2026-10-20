import type { TextMotionBlurPlan } from "../text/text-motion-blur-plan";

interface RasterAddress {
  compositionId: string;
  layerId: string;
  instanceId: string;
}

/** Only the native evaluator chooses scene addresses, clocks, density and shutter samples. */
export type RetainedRasterRequest = RasterAddress &
  (
    | {
        kind: "text";
        sourceTime: number;
        frameRate: number;
        resolutionScale: number;
        exposure: TextMotionBlurPlan | null;
      }
    | { kind: "svg"; sourceId: string; width: number; height: number }
    | { kind: "psd"; sourceId: string }
  );
