import { describe, expect, it, vi } from "vitest";
import {
  buildTemporalTextPassPlan,
  executeTemporalTextPassPlan,
  type TemporalTextPassDestination,
} from "./text-motion-blur-pass-plan";

function fixture() {
  const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const bindings = [{}, {}, {}] as GPUBindGroup[];
  const resources = {
    hashFor: (id: string) => ids[id === "output" ? 0 : Number(id.split(":")[1]) + 1],
    bindingForHash: (hash: string | null | undefined): GPUBindGroup | undefined =>
      bindings[ids.indexOf(String(hash))],
  };
  const weights = [0.25, 0.5];
  const plan = structuredClone(buildTemporalTextPassPlan(2, 1, weights, resources));
  const passes = Array.from({ length: 2 }, () => ({
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  }));
  const encoder = {
    beginRenderPass: vi.fn().mockReturnValueOnce(passes[0]).mockReturnValueOnce(passes[1]),
  } as unknown as GPUCommandEncoder;
  const destination = {
    queue: { writeBuffer: vi.fn() },
    width: 2,
    height: 1,
    output: { createView: vi.fn() },
    outputBinding: bindings[0],
    accumulation: { createView: vi.fn() },
    weights: { size: 512 },
    resolveBinding: {},
    accumulatePipeline: {},
    resolvePipeline: {},
  } as unknown as TemporalTextPassDestination;
  return { weights, plan, resources, encoder, destination, passes };
}

describe("supplied temporal pass execution", () => {
  it("executes cloned hashes and weights after producer inputs are discarded", () => {
    const f = fixture();
    f.weights.length = 0;
    f.plan.samples[0].weight = 0.125;
    executeTemporalTextPassPlan(f.plan, f.resources, f.encoder, f.destination);
    const data = vi.mocked(f.destination.queue.writeBuffer).mock.calls[0][2] as Float32Array;
    expect([data[0], data[64]]).toEqual([0.125, 0.5]);
    expect(f.passes[0].setBindGroup.mock.calls).toEqual(
      f.plan.samples.map((s) => [0, f.resources.bindingForHash(s.hash)]),
    );
    expect(f.passes[0].draw).toHaveBeenCalledTimes(2);
    expect(f.passes[1].draw).toHaveBeenCalledOnce();
  });

  it.each(["extent", "output", "slot", "missing", "weights", "duplicate"])(
    "rejects invalid %s before writing uniforms or encoding commands",
    (failure) => {
      const f = fixture();
      if (failure === "extent") f.plan.width = 3;
      if (failure === "output") f.destination.outputBinding = {} as GPUBindGroup;
      if (failure === "slot") f.plan.samples.reverse();
      if (failure === "missing") {
        const resolve = f.resources.bindingForHash;
        f.resources.bindingForHash = (hash) => (hash === f.plan.output ? resolve(hash) : undefined);
      }
      if (failure === "weights") f.destination.weights = undefined;
      if (failure === "duplicate") f.plan.samples[1].hash = f.plan.samples[0].hash;
      expect(() =>
        executeTemporalTextPassPlan(f.plan, f.resources, f.encoder, f.destination),
      ).toThrow();
      expect(f.destination.queue.writeBuffer).not.toHaveBeenCalled();
      expect(f.encoder.beginRenderPass).not.toHaveBeenCalled();
    },
  );
});
