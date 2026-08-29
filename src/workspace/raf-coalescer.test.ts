import { describe, expect, it } from "vitest";
import { type AnimationFrameHost, RafCoalescer } from "./raf-coalescer";

function controlledHost() {
  let callback: FrameRequestCallback | undefined;
  let requests = 0;
  let cancellations = 0;
  const host: AnimationFrameHost = {
    request: (next) => {
      callback = next;
      requests += 1;
      return requests;
    },
    cancel: () => {
      callback = undefined;
      cancellations += 1;
    },
  };
  return {
    host,
    frame: () => callback?.(0),
    requests: () => requests,
    cancellations: () => cancellations,
  };
}

describe("RafCoalescer", () => {
  it("applies only the latest pointer value in each animation frame", () => {
    const frames = controlledHost();
    const applied: number[] = [];
    const coalescer = new RafCoalescer(frames.host, (value: number) => applied.push(value));
    coalescer.schedule(0.2);
    coalescer.schedule(0.4);
    coalescer.schedule(0.7);
    expect(frames.requests()).toBe(1);
    expect(applied).toEqual([]);
    frames.frame();
    expect(applied).toEqual([0.7]);
  });

  it("flushes one final resize transaction and cancels an outstanding frame", () => {
    const frames = controlledHost();
    const applied: number[] = [];
    const coalescer = new RafCoalescer(frames.host, (value: number) => applied.push(value));
    coalescer.schedule(0.65);
    coalescer.flush();
    expect(applied).toEqual([0.65]);
    expect(frames.cancellations()).toBe(1);
    coalescer.flush();
    expect(applied).toEqual([0.65]);
  });
});
