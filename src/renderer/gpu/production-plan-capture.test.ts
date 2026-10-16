import { expect, it, vi } from "vitest";
import { nativeFramePacket } from "../compositing/native-frame-packet";
import { frameBundleFixtures } from "../frame-plan/frame-bundle-fixture";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import { ProductionFrameCapture } from "./production-frame-capture";

it.each(
  ["plan", "packet"].flatMap((mode) =>
    ["success", "failure", "abort", "submit-failure"].map((outcome) => ({ mode, outcome })),
  ),
)("owns media across deferred $mode $outcome", async ({ mode, outcome }) => {
  const expected = frameBundleFixtures()[1].frameBundle;
  let resolve!: (bundle: FrameBundle) => void;
  let reject!: (error: Error) => void;
  const plan = new Promise<FrameBundle>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const release = vi.fn();
  let pendingTemporalPasses = true;
  const media = {
    resourceMessages: [],
    retainForCapture: vi.fn(() => ({ release })),
  } as unknown as MediaBindingLease;
  const textures = {
    flush: vi.fn(() => {
      pendingTemporalPasses = false;
      if (outcome === "submit-failure") throw new Error("Submit failed");
    }),
    submitted: vi.fn(),
  } as unknown as RendererResources["mediaTextures"];
  const device = {
    createCommandEncoder: () => ({ finish: () => ({}) }),
    queue: { submit: vi.fn() },
  } as unknown as GPUDevice;
  const capture = new ProductionFrameCapture(() => {
    throw Error("Unused context");
  });
  const builder = vi.fn(() => {
    expect(pendingTemporalPasses).toBe(true);
    return plan;
  });
  const retained = new Set(expected.resources.map((resource) => resource.message.hash));
  const expectedPacket = nativeFramePacket(expected, retained);
  const options = {
    resources: { hasPendingFrameResources: false, waitForFrameResources: async () => {} },
    synchronizeVideo: false,
    render() {
      capture.submitPlan({
        device,
        bundle: builder,
        header: expected.plan.metadata.header,
        media,
        textures,
        memory: { budgetMb: 64, estimatedBytes: 0, pressure: "normal", shadowMapSize: 1 },
        started: performance.now(),
        cacheHitRate: 0,
      });
    },
  };
  const result =
    mode === "packet"
      ? capture.capturePacket({ ...options, retained })
      : capture.capturePlan(options);
  retained.clear();
  await Promise.resolve();
  expect(builder).toHaveBeenCalledOnce();
  expect(media.retainForCapture).toHaveBeenCalledWith([]);
  expect(release).not.toHaveBeenCalled();
  if (outcome === "abort") capture.abort();
  if (outcome === "failure") reject(new Error("Hash failed"));
  else resolve(expected);
  if (outcome === "success")
    await expect(result).resolves.toEqual(
      mode === "packet" ? expectedPacket : { ...expected, submittedPlan: expected.plan },
    );
  else
    await expect(result).rejects.toThrow(
      outcome === "failure"
        ? /Hash failed/
        : outcome === "submit-failure"
          ? /Submit failed/
          : /aborted/,
    );
  expect(release).toHaveBeenCalledOnce();
});
