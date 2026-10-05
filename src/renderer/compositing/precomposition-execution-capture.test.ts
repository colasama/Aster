import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPrecompositionBundle } from "../frame-plan/precomposition-bundle-plan";
import { readPrecompositionBundle } from "../frame-plan/precomposition-bundle-read";
import { precompositionGraphFixtures } from "../frame-plan/precomposition-graph-fixture";
import { MediaBindingLease } from "../media/media-binding-lease";
import type { SceneGeneratorHost } from "../scene/scene-generator-host";
import { capturePrecompositionExecution } from "./precomposition-bundle-capture";
import { PrecompositionSurfaceRenderer } from "./precomposition-surface-renderer";
import {
  blendPipelines,
  installGpuConstants,
  mockDevice,
  mockEncoder,
} from "./precomposition-test-gpu";

function renderer(host?: SceneGeneratorHost) {
  installGpuConstants();
  const device = mockDevice([], vi.fn());
  const layout = device.createBindGroupLayout({ entries: [] });
  return new PrecompositionSurfaceRenderer(device, {
    mediaLayout: layout,
    mediaSampler: device.createSampler(),
    lightingLayout: layout,
    shapePipelines: blendPipelines(),
    imagePipelines: blendPipelines(),
    sceneGenerators: host,
  });
}
function fixture() {
  const f = precompositionGraphFixtures(true)[0];
  return buildPrecompositionBundle(f, f.plans, []);
}

describe("captured recursive execution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("replays an unavailable generator on a healthy consumer without requesting allocation", () => {
    const producer = renderer({
      preparePlanned: vi.fn(() => undefined),
    } as unknown as SceneGeneratorHost);
    const healthy = { preparePlanned: vi.fn(), encodeCompute: vi.fn(), encodeDraw: vi.fn() };
    const consumer = renderer(healthy as unknown as SceneGeneratorHost);
    const media = new MediaBindingLease([]);
    try {
      const bundle = fixture();
      const executed = producer.prepareBundle(bundle);
      const captured = capturePrecompositionExecution(bundle, executed);
      producer.destroy();
      const plans = consumer.prepareBundle(captured);
      const events: string[] = [];
      consumer.encode(mockEncoder(events), plans, media);
      expect(healthy.preparePlanned).not.toHaveBeenCalled();
      expect(healthy.encodeCompute).not.toHaveBeenCalled();
      expect(healthy.encodeDraw).not.toHaveBeenCalled();
      expect(plans[0].generators[0].execution).toEqual({ status: "unavailable" });
      expect(events.filter((event) => event === "draw").length).toBeGreaterThan(0);
      const absentHost = renderer();
      try {
        const plans = absentHost.prepareBundle(captured);
        absentHost.encode(mockEncoder([]), plans, media);
      } finally {
        absentHost.destroy();
      }
    } finally {
      media.release();
      consumer.destroy();
    }
  });

  it("preserves reduced execution counts on a larger device and rejects a smaller or failed allocation", () => {
    const prepare = vi.fn((plan) => ({
      instanceId: plan.instanceId,
      effectiveCount: 3,
      resources: { capacity: 3 },
    }));
    const producer = renderer({ preparePlanned: prepare } as unknown as SceneGeneratorHost);
    const replay = vi.fn((plan) => ({
      instanceId: plan.instanceId,
      effectiveCount: plan.effectiveCount,
      resources: { capacity: 1024 },
    }));
    const consumer = renderer({ preparePlanned: replay } as unknown as SceneGeneratorHost);
    try {
      const bundle = fixture();
      const executed = producer.prepareBundle(bundle);
      expect(prepare.mock.calls[0][0].effectiveCount).toBeGreaterThan(3);
      const captured = capturePrecompositionExecution(bundle, executed);
      const plans = consumer.prepareBundle(captured);
      expect(replay.mock.calls[0][0].effectiveCount).toBe(3);
      expect(new DataView(replay.mock.calls[0][0].context.buffer).getUint32(24, true)).toBe(3);
      expect(plans[0].generators[0].execution).toEqual({
        status: "ready",
        capacity: 3,
        effective_count: 3,
      });
      expect(
        readPrecompositionBundle(
          capturePrecompositionExecution(captured, plans).plan,
          captured.resources,
        ).plans[0].generators[0].execution,
      ).toEqual(plans[0].generators[0].execution);
      replay.mockReturnValueOnce({
        instanceId: "reduced",
        effectiveCount: 2,
        resources: { capacity: 2 },
      });
      expect(() => consumer.prepareBundle(captured)).toThrow(/cannot be reproduced/);
    } finally {
      producer.destroy();
      consumer.destroy();
    }
  });

  it("rejects unobserved outcomes and results from another scene generation", () => {
    const producer = renderer({
      preparePlanned: vi.fn(() => undefined),
    } as unknown as SceneGeneratorHost);
    try {
      const bundle = fixture();
      expect(() =>
        capturePrecompositionExecution(
          bundle,
          readPrecompositionBundle(bundle.plan, bundle.resources).plans,
        ),
      ).toThrow(/not completed/);
      const executed = producer.prepareBundle(bundle);
      executed[0].label += "changed";
      expect(() => capturePrecompositionExecution(bundle, executed)).toThrow(/scene generation/);
    } finally {
      producer.destroy();
    }
  });
});
