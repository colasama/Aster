// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

it("delivers across independently loaded clock modules and removes exact subscriptions", async () => {
  const viewportModule = await import("./playback-frame");
  const receive = vi.fn();
  const unsubscribe = viewportModule.onPlaybackFrame(receive);
  vi.resetModules();
  const clockModule = await import("./playback-frame");
  const frame = { compositionId: "main", time: 2.4 };
  clockModule.publishPlaybackFrame(frame);
  expect(receive).toHaveBeenCalledExactlyOnceWith(frame);
  unsubscribe();
  clockModule.publishPlaybackFrame({ ...frame, time: 3 });
  expect(receive).toHaveBeenCalledTimes(1);
});
