import { describe, expect, it } from "vitest";
import { SimulationCheckpointCache } from "./simulation-checkpoints";

describe("SimulationCheckpointCache", () => {
  it("captures only at the configured deterministic cadence", () => {
    const cache = new SimulationCheckpointCache({ checkpointIntervalFrames: 30 });
    expect(cache.shouldCapture(0)).toBe(true);
    expect(cache.shouldCapture(29)).toBe(false);
    expect(cache.shouldCapture(30)).toBe(true);
  });

  it("restores the nearest checkpoint at or before a target", () => {
    const cache = new SimulationCheckpointCache();
    cache.capture("particles:main", 120, new Uint8Array([1]));
    cache.capture("particles:main", 240, new Uint8Array([2]));
    cache.capture("particles:main", 360, new Uint8Array([3]));

    expect(cache.planSeek("particles:main", 300)).toEqual({
      mode: "restore",
      checkpoint: { frame: 240, state: new Uint8Array([2]), streamId: "particles:main" },
      replayFrames: 60,
    });
  });

  it("continues a nearby forward seek without a readback or restore", () => {
    const cache = new SimulationCheckpointCache({ maxForwardReplayFrames: 8 });
    expect(cache.planSeek("fluid:preview", 107, 100)).toEqual({
      mode: "continue",
      replayFromFrame: 100,
      replayFrames: 7,
    });
    expect(cache.planSeek("fluid:preview", 99, 100).mode).toBe("restart");
  });

  it("copies captured and restored bytes across the cache boundary", () => {
    const cache = new SimulationCheckpointCache();
    const source = new Uint8Array([4, 5, 6]);
    cache.capture("simulation", 0, source);
    source[0] = 9;
    const restored = cache.nearest("simulation", 0);
    expect(restored?.state).toEqual(new Uint8Array([4, 5, 6]));
    if (restored) restored.state[1] = 9;
    expect(cache.nearest("simulation", 0)?.state).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("evicts least-recently-used snapshots within byte and entry budgets", () => {
    const cache = new SimulationCheckpointCache({ maxBytes: 6, maxEntries: 2 });
    cache.capture("sim", 0, new Uint8Array([0, 0]));
    cache.capture("sim", 10, new Uint8Array([1, 1]));
    cache.nearest("sim", 0);
    cache.capture("sim", 20, new Uint8Array([2, 2]));

    expect(cache.nearest("sim", 10)?.frame).toBe(0);
    expect(cache.nearest("sim", 20)?.frame).toBe(20);
    expect(cache.statistics()).toMatchObject({ bytes: 4, entries: 2, evictions: 1 });
  });

  it("invalidates future state after an edit and rejects unsafe inputs", () => {
    const cache = new SimulationCheckpointCache({ maxBytes: 4 });
    cache.capture("sim", 0, new Uint8Array([0]));
    cache.capture("sim", 120, new Uint8Array([1]));
    cache.invalidateAfter("sim", 20);
    expect(cache.nearest("sim", 120)?.frame).toBe(0);
    expect(cache.capture("sim", 240, new Uint8Array(5))).toBe(false);
    expect(() => cache.capture("../unsafe", 0, new Uint8Array([1]))).toThrow(/streamId/);
    expect(() => cache.planSeek("sim", -1)).toThrow(/frame/);
  });
});
