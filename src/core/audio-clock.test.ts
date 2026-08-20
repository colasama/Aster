import { describe, expect, it } from "vitest";
import { AudioTimelineClock } from "./audio-clock";

const SAMPLE_RATE = 48_000;

function createClock(durationSeconds = 10): AudioTimelineClock {
  return new AudioTimelineClock({
    sampleRate: SAMPLE_RATE,
    durationSamples: durationSeconds * SAMPLE_RATE,
  });
}

describe("AudioTimelineClock", () => {
  it("tracks sample frames from explicit host timestamps without cumulative rounding", () => {
    const clock = createClock();
    clock.seekSamples(101, 3);
    clock.play(3);

    expect(clock.snapshot(3.001).exactSample).toBeCloseTo(149, 8);
    expect(clock.snapshot(3.001).sample).toBe(149);
    expect(clock.snapshot(3.125).sample).toBe(6_101);
  });

  it("supports pause, sample-accurate seek, and rate changes", () => {
    const clock = createClock();
    clock.play(0);
    expect(clock.pause(0.25).sample).toBe(12_000);
    expect(clock.snapshot(5).sample).toBe(12_000);

    expect(clock.seekSeconds(1 / SAMPLE_RATE, 5).sample).toBe(1);
    clock.setPlaybackRate(2, 5);
    clock.play(5);
    expect(clock.snapshot(5.5).sample).toBe(48_001);
  });

  it("ignores sub-tolerance drift and slews a moderate offset for one bounded window", () => {
    const clock = createClock();
    clock.play(0);

    const ignored = clock.synchronize(1.003, 1);
    expect(ignored.action).toBe("none");
    expect(ignored.driftSamples).toBe(144);

    const correction = clock.synchronize(1.02, 1);
    expect(correction.action).toBe("slew");
    expect(correction.correctionRate).toBeCloseTo(0.04);
    expect(clock.snapshot(1.5).sample).toBe(72_960);
    expect(clock.snapshot(2).sample).toBe(96_960);
    expect(clock.snapshot(2).correctionRate).toBe(0);
  });

  it("bounds slew rate and hard-resyncs large or paused drift", () => {
    const clock = createClock();
    clock.play(0);
    const bounded = clock.synchronize(0.1, 0);
    expect(bounded.action).toBe("slew");
    expect(bounded.correctionRate).toBe(0.05);

    const resynced = clock.synchronize(2, 0);
    expect(resynced.action).toBe("resync");
    expect(resynced.snapshot.sample).toBe(96_000);

    clock.pause(0);
    const paused = clock.synchronize(2.1, 0);
    expect(paused.action).toBe("resync");
    expect(paused.snapshot.sample).toBe(100_800);
  });

  it("clamps seeks and playback at the media duration", () => {
    const clock = createClock(1);
    expect(clock.seekSamples(-20, 0).sample).toBe(0);
    expect(clock.seekSamples(100_000, 0).sample).toBe(48_000);
    expect(clock.play(0).playing).toBe(false);

    clock.seekSamples(47_900, 0);
    clock.play(0);
    const ended = clock.snapshot(1);
    expect(ended.sample).toBe(48_000);
    expect(ended.ended).toBe(true);
    expect(ended.playing).toBe(false);
  });

  it("rejects invalid configuration and non-monotonic control timestamps", () => {
    expect(() => new AudioTimelineClock({ sampleRate: 0, durationSamples: 1 })).toThrow(RangeError);
    expect(
      () =>
        new AudioTimelineClock({
          sampleRate: SAMPLE_RATE,
          durationSamples: 1,
          driftToleranceSeconds: 0.5,
          hardResyncSeconds: 0.25,
        }),
    ).toThrow("hardResyncSeconds");

    const clock = createClock();
    clock.play(2);
    expect(() => clock.pause(1)).toThrow("monotonic");
    expect(() => clock.setPlaybackRate(Number.NaN, 2)).toThrow(RangeError);
    expect(() => clock.seekSamples(0.5, 2)).toThrow("safe integer");
  });
});
