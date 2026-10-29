// @vitest-environment node
import type { WebFrameMain } from "electron";
import { sharedTexture } from "electron";
import { afterEach, expect, test, vi } from "vitest";
import { NativePreviewBroker } from "./native-preview-broker";
import type { NativePreviewClient } from "./native-preview-client";

vi.mock("electron", () => ({
  sharedTexture: { importSharedTexture: vi.fn(), sendSharedTexture: vi.fn() },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

function fixture() {
  let released = () => {};
  const texture = { release: vi.fn() };
  vi.mocked(sharedTexture.importSharedTexture).mockImplementation((options) => {
    released = options.allReferencesReleased ?? (() => {});
    return texture as ReturnType<typeof sharedTexture.importSharedTexture>;
  });
  vi.mocked(sharedTexture.sendSharedTexture).mockResolvedValue();
  const client = {
    ready: Promise.resolve(),
    current: { slots: 2, width: 16, height: 16, source: {} },
    present: vi.fn().mockResolvedValue({
      sequence: 1,
      generation: 1,
      time: 0.5,
      nt_handle: [1, 0, 0, 0, 0, 0, 0, 0],
      render_and_share_ms: 1,
    }),
    release: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
  };
  return {
    broker: new NativePreviewBroker(client as unknown as NativePreviewClient),
    client,
    texture,
    released: () => released(),
  };
}

test("presentation waits for GPU-tracked imports and the producer release acknowledgement", async () => {
  const { broker, client, texture, released } = fixture();
  let acknowledge = () => {};
  client.release.mockReturnValue(
    new Promise<void>((resolve) => {
      acknowledge = resolve;
    }),
  );
  const done = vi.fn();
  const pending = broker.present({} as WebFrameMain, {}, 0.5).then(done);
  await vi.waitFor(() => expect(texture.release).toHaveBeenCalledOnce());
  expect(done).not.toHaveBeenCalled();
  expect(client.release).not.toHaveBeenCalled();
  released();
  await Promise.resolve();
  expect(client.release).toHaveBeenCalledWith(1);
  expect(done).not.toHaveBeenCalled();
  acknowledge();
  await pending;
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }));
});

test("a lost consumer has a bounded drain and cannot admit another presentation", async () => {
  vi.useFakeTimers();
  const { broker, client } = fixture();
  const pending = broker.present({} as WebFrameMain, {}, 0.5);
  const rejected = expect(pending).rejects.toThrow("Preview GPU references did not drain");
  await vi.advanceTimersByTimeAsync(30001);
  await rejected;
  expect(client.abort).toHaveBeenCalledOnce();
  await expect(broker.present({} as WebFrameMain, {}, 1)).rejects.toThrow("did not drain");
});

test("a rejected producer release fails presentation and retires the transport", async () => {
  const { broker, client, texture, released } = fixture();
  client.release.mockRejectedValue(new Error("producer release failed"));
  const pending = broker.present({} as WebFrameMain, {}, 0.5);
  const rejected = expect(pending).rejects.toThrow("producer release failed");
  await vi.waitFor(() => expect(texture.release).toHaveBeenCalledOnce());
  released();
  await rejected;
  expect(client.abort).toHaveBeenCalledOnce();
});

test("IOSurface imports stay owned until Electron releases every GPU reference", async () => {
  const { broker, client, texture, released } = fixture();
  const pointer = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
  client.present.mockResolvedValue({
    sequence: 1,
    generation: 1,
    time: 0.5,
    ioSurface: pointer,
    render_and_share_ms: 1,
  });
  const pending = broker.present({} as WebFrameMain, {}, 0.5);
  await vi.waitFor(() => expect(texture.release).toHaveBeenCalledOnce());
  expect(sharedTexture.importSharedTexture).toHaveBeenCalledWith(
    expect.objectContaining({
      textureInfo: expect.objectContaining({ handle: { ioSurface: pointer } }),
    }),
  );
  expect(client.release).not.toHaveBeenCalled();
  released();
  await pending;
  expect(client.release).toHaveBeenCalledWith(1);
});
