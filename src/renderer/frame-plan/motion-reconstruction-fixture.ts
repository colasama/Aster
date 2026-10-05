import { DEFAULT_MOTION_BLUR_SETTINGS } from "../../core/animation/motion-blur";
import { encodeFramePlan } from "./codec";
import { buildMotionReconstructionPlan } from "./motion-reconstruction-plan";
import { buildFrameHeader } from "./root-post-plan";

export function motionReconstructionFixtures() {
  const cases = [
    {
      id: "ready",
      requested: true,
      available: true,
      open: 1.24,
      duration: 0.02,
      samples: 8,
      adaptive: 32,
      width: 128,
      position: 0.5,
    },
    {
      id: "disabled",
      requested: false,
      available: true,
      open: 1.24,
      duration: 0.02,
      samples: 8,
      adaptive: 32,
      width: 128,
      position: 0.5,
    },
    {
      id: "unavailable",
      requested: true,
      available: false,
      open: 1.24,
      duration: 0.02,
      samples: 8,
      adaptive: 32,
      width: 128,
      position: 0.5,
    },
    {
      id: "zero",
      requested: true,
      available: true,
      open: 1.25,
      duration: 0,
      samples: 8,
      adaptive: 32,
      width: 128,
      position: 0.5,
    },
    {
      id: "phase",
      requested: true,
      available: true,
      open: -0.25,
      duration: 0.5,
      samples: 8,
      adaptive: 32,
      width: 64,
      position: 3,
    },
    {
      id: "bounded",
      requested: true,
      available: true,
      open: -0.25,
      duration: 0.01,
      samples: 200,
      adaptive: 1,
      width: 0,
      position: 4,
    },
  ];
  return cases.map((item) => {
    const settings = {
      ...DEFAULT_MOTION_BLUR_SETTINGS,
      samplesPerFrame: item.samples,
      adaptiveSampleLimit: item.adaptive,
    };
    const plan = buildMotionReconstructionPlan(
      buildFrameHeader({
        snapshot: { snapshotScope: "motion-fixture", projectRevision: 3 },
        compositionId: "motion",
        time: 1.25,
        frameRate: { numerator: 30000, denominator: 1001 },
        target: { width: 64, height: 48 },
        renderTarget: { width: 64, height: 48 },
        antiAliasing: "off",
      }),
      {
        requested: item.requested,
        resourcesAvailable: item.available,
        settings,
        shutter: { openTime: item.open, duration: item.duration },
        compositionWidth: item.width,
      },
    );
    settings.samplesPerFrame = 3;
    return {
      id: `motion-${item.id}`,
      plan,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
      motion: {
        status: item.requested && item.available ? "ready" : "skipped",
        samples: item.id === "bounded" ? 64 : 8,
        adaptive: item.id === "bounded" ? 64 : 32,
        radius: item.width === 128 ? 128 : 256,
        position: item.position,
        open: item.open,
        duration: item.duration,
      },
    };
  });
}
