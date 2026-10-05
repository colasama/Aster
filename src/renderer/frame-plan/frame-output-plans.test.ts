import { describe, expect, it } from "vitest";
import { DEFAULT_MOTION_BLUR_SETTINGS } from "../../core/animation/motion-blur";
import { executeFrameOutput } from "../compositing/execute-frame-output";
import { buildAuxiliaryPlan } from "./auxiliary-plan";
import { finalOutputFixtures } from "./final-output-fixture";
import { type FrameOutputPlans, validateFrameOutputPlans } from "./frame-output-plans";
import { buildMotionReconstructionPlan } from "./motion-reconstruction-plan";
import { postEffectFixtures } from "./post-effect-fixture";

function outputSequence(): FrameOutputPlans {
  const output = finalOutputFixtures().find((f) => f.id === "output-beauty-motion")?.plan;
  if (!output) throw Error("Missing output fixture");
  return {
    auxiliary: null,
    effect: null,
    output,
    motion: buildMotionReconstructionPlan(output.metadata.header, {
      requested: true,
      resourcesAvailable: true,
      settings: DEFAULT_MOTION_BLUR_SETTINGS,
      shutter: { openTime: 1.24, duration: 0.02 },
      compositionWidth: 64,
    }),
  };
}
describe("supplied output sequence preflight", () => {
  it("accepts independently owned stages sharing one complete frame identity", () => {
    const plans = outputSequence();
    expect(validateFrameOutputPlans(structuredClone(plans))).toEqual({
      header: plans.output.metadata.header,
      motionReady: true,
    });
  });
  const faults: [string, (p: FrameOutputPlans) => void][] = [
    [
      "frame mismatch",
      (p) => {
        p.motion.metadata.header.project_revision++;
      },
    ],
    [
      "missing effect",
      (p) => {
        const final = p.output.metadata.slices[0];
        if (final.kind === "final_output") final.route = { kind: "depth", mode: "depthOfField" };
      },
    ],
    [
      "unexpected effect",
      (p) => {
        p.effect = postEffectFixtures()[0].plan;
        p.effect.metadata.header = structuredClone(p.output.metadata.header);
      },
    ],
    [
      "skipped motion",
      (p) => {
        const motion = p.motion.metadata.slices[0];
        if (motion.kind === "motion_reconstruction") motion.status = "skipped";
      },
    ],
    [
      "cleared auxiliary",
      (p) => {
        p.auxiliary = buildAuxiliaryPlan(
          p.output.metadata.header,
          { status: "cleared", tier: 0, vertex_count: 0, draws: [], generators: [] },
          new Uint32Array(),
        );
      },
    ],
    [
      "nonplain stage",
      (p) => {
        Object.setPrototypeOf(p.output, new Map());
      },
    ],
    [
      "closure in metadata",
      (p) => {
        Object.assign(p.output.metadata, { evaluate: () => {} });
      },
    ],
  ];
  for (const [name, alter] of faults)
    it(`rejects ${name} before touching GPU execution context`, () => {
      const plans = outputSequence();
      alter(plans);
      const touched: string[] = [];
      const input = new Proxy(
        { plans },
        {
          get(target, key) {
            if (key === "plans") return target.plans;
            touched.push(String(key));
            throw Error("GPU context touched");
          },
        },
      );
      expect(() => executeFrameOutput(input as Parameters<typeof executeFrameOutput>[0])).toThrow();
      expect(touched).toEqual([]);
    });
});
