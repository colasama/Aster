import { describe, expect, it } from "vitest";
import { AsyncWorkPool } from "./async-work-pool";

describe("bounded asynchronous work pool", () => {
  it("never exceeds its decode concurrency and drains queued work", async () => {
    const pool = new AsyncWorkPool(2);
    let active = 0;
    let maximum = 0;
    const gates: Array<() => void> = [];
    const work = Array.from({ length: 5 }, (_, index) =>
      pool.run(
        () =>
          new Promise<number>((resolve) => {
            active += 1;
            maximum = Math.max(maximum, active);
            gates.push(() => {
              active -= 1;
              resolve(index);
            });
          }),
      ),
    );
    expect(pool.statistics()).toEqual({ active: 2, queued: 3, concurrency: 2 });
    while (gates.length > 0 || pool.statistics().queued > 0) {
      gates.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(await Promise.all(work)).toEqual([0, 1, 2, 3, 4]);
    expect(maximum).toBe(2);
  });

  it("continues after a failed task", async () => {
    const pool = new AsyncWorkPool(1);
    const failed = pool.run(async () => {
      throw new Error("decode failed");
    });
    const recovered = pool.run(async () => "decoded");
    await expect(failed).rejects.toThrow("decode failed");
    await expect(recovered).resolves.toBe("decoded");
  });
});
