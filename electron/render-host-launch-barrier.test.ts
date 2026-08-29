import { describe, expect, it, vi } from "vitest";
import { prepareAuthorizedRenderHost } from "./render-host-launch-barrier";

describe("RenderHost launch authorization barrier", () => {
  it("authorizes media before preparing output staging", async () => {
    const order: string[] = [];
    await prepareAuthorizedRenderHost(
      async () => {
        order.push("authorize");
      },
      async () => {
        order.push("publisher");
      },
    );
    expect(order).toEqual(["authorize", "publisher"]);
  });

  it("never prepares output staging after authorization failure", async () => {
    const prepare = vi.fn(async () => undefined);
    await expect(
      prepareAuthorizedRenderHost(async () => {
        throw new Error("render media identity mismatch");
      }, prepare),
    ).rejects.toThrow("identity mismatch");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("releases a completed media authorization when publisher preparation fails", async () => {
    const lease = { dispose: vi.fn() };
    await expect(
      prepareAuthorizedRenderHost(
        async () => lease,
        async () => {
          throw new Error("output staging failed");
        },
        (authorized) => authorized.dispose(),
      ),
    ).rejects.toThrow("output staging failed");
    expect(lease.dispose).toHaveBeenCalledOnce();
  });
});
