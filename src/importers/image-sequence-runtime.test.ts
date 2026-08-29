import { describe, expect, it, vi } from "vitest";
import { detectImageSequence } from "./image-sequence";
import { ImageSequenceFrameCache, resolveImageSequenceFrame } from "./image-sequence-runtime";

const file = (name: string, size = 10) => ({ name, size, lastModified: 1, type: "image/png" });

describe("image sequence runtime", () => {
  it("resolves exact and missing frames with deterministic policies", () => {
    const sequence = detectImageSequence([
      file("shot_1001.png"),
      file("shot_1003.png"),
      file("shot_1006.png"),
    ]);
    const rate = { numerator: 24, denominator: 1 };
    expect(resolveImageSequenceFrame(sequence, 0, rate)).toMatchObject({
      requestedFrame: 1001,
      actualFrame: 1001,
      missing: false,
    });
    expect(resolveImageSequenceFrame(sequence, 1 / 24, rate)).toMatchObject({
      requestedFrame: 1002,
      actualFrame: 1001,
      missing: true,
    });
    expect(
      resolveImageSequenceFrame(sequence, 4 / 24, rate, { missingFramePolicy: "nearest" }),
    ).toMatchObject({ requestedFrame: 1005, actualFrame: 1006 });
    expect(() =>
      resolveImageSequenceFrame(sequence, 1 / 24, rate, { missingFramePolicy: "error" }),
    ).toThrow("1002 is missing");
    expect(resolveImageSequenceFrame(sequence, 6 / 24, rate, { loop: true })).toMatchObject({
      requestedFrame: 1001,
      actualFrame: 1001,
    });
  });

  it("deduplicates concurrent decodes and invalidates reloaded file identities", async () => {
    let release: ((value: string) => void) | undefined;
    const decode = vi.fn(
      (source: ReturnType<typeof file>) =>
        new Promise<string>((resolve) => {
          release = () => resolve(source.name);
        }),
    );
    const cache = new ImageSequenceFrameCache({ decode, estimateBytes: () => 10 });
    const first = { frame: 1, file: file("a0001.png") };
    const pendingA = cache.get(first);
    const pendingB = cache.get(first);
    expect(decode).toHaveBeenCalledTimes(1);
    release?.("a0001.png");
    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual(["a0001.png", "a0001.png"]);
    expect(cache.size).toBe(1);
    const reloaded = cache.get({ frame: 1, file: { ...first.file, lastModified: 2 } });
    release?.("a0001.png");
    await reloaded;
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used frames by count and byte budget", async () => {
    const disposed: string[] = [];
    const cache = new ImageSequenceFrameCache({
      decode: async (source: ReturnType<typeof file>) => source.name,
      estimateBytes: () => 10,
      dispose: (value) => disposed.push(value),
      maxEntries: 2,
      maxBytes: 20,
    });
    const one = { frame: 1, file: file("a0001.png") };
    const two = { frame: 2, file: file("a0002.png") };
    const three = { frame: 3, file: file("a0003.png") };
    await cache.get(one);
    await cache.get(two);
    await cache.get(one);
    await cache.get(three);
    expect(disposed).toEqual(["a0002.png"]);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(20);
    cache.clear();
    expect(new Set(disposed)).toEqual(new Set(["a0001.png", "a0002.png", "a0003.png"]));
  });

  it("preloads closest frames first while respecting the concurrency bound", async () => {
    const sequence = detectImageSequence(
      Array.from({ length: 7 }, (_, index) =>
        file(`shot_${String(index + 1).padStart(4, "0")}.png`),
      ),
    );
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const cache = new ImageSequenceFrameCache({
      decode: async (source: ReturnType<typeof file>) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(source.name);
        await Promise.resolve();
        active -= 1;
        return source.name;
      },
      estimateBytes: () => 1,
    });
    await cache.preload(sequence.frames, 4, 2, 2);
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(order[0]).toBe("shot_0004.png");
    expect(new Set(order)).toEqual(
      new Set([
        "shot_0002.png",
        "shot_0003.png",
        "shot_0004.png",
        "shot_0005.png",
        "shot_0006.png",
      ]),
    );
  });
});
