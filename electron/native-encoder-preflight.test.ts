// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { prepareNativeEncoder } from "./native-encoder-preflight";
import type { NativeSessionCommand } from "./native-render-protocol";

const state = vi.hoisted(() => ({
  attempts: [] as { args: string[]; commands: string[]; disposed: boolean }[],
  fail: "shared",
  cancelled: false,
}));
vi.mock("./native-render-client.js", () => ({
  NativeRenderClient: class {
    readonly record;
    constructor(options: { args: string[] }) {
      this.record = { args: options.args, commands: [] as string[], disposed: false };
      state.attempts.push(this.record);
    }
    async request(command: NativeSessionCommand) {
      this.record.commands.push(command.type);
      const shared = this.record.args.includes("--native-export");
      if (command.type === "probe") {
        if (state.fail === "probe") throw new Error("probe failed");
        return { response: { encoder: { test_frame_verified: true } } };
      }
      if (state.fail === "both" || (shared && state.fail !== "none")) {
        if (state.fail === "cancel") state.cancelled = true;
        throw new Error("driver access violation");
      }
      return {
        response: { transport: shared ? "nv12-shared" : "nv12-readback", transport_reason: null },
      };
    }
    async dispose() {
      this.record.disposed = true;
    }
  },
}));
beforeEach(() => {
  state.attempts.length = 0;
  state.fail = "shared";
  state.cancelled = false;
});
const prepare = () =>
  prepareNativeEncoder({
    binary: "renderer",
    args: ["--dxcompiler", "compiler"],
    video: {
      size: { width: 320, height: 180 },
      frame_rate: { numerator: 30, denominator: 1 },
      bitrate_bps: 8000000,
    },
    frameCount: 12,
    own: () => {},
    assertActive: () => {
      if (state.cancelled) throw new Error("cancelled");
    },
  });

it("requalifies hardware in a fresh readback process after shared initialization failure", async () => {
  const result = await prepare();
  expect(state.attempts).toHaveLength(2);
  expect(state.attempts[0].disposed).toBe(true);
  expect(state.attempts[1].disposed).toBe(false);
  expect(state.attempts.map((a) => a.commands)).toEqual([
    ["probe", "begin_export"],
    ["probe", "begin_export"],
  ]);
  expect(result.reply.response.transport).toBe("nv12-readback");
  expect(result.reply.response.transport_reason).toMatch(/driver access violation/);
});
it.each(["both", "probe", "cancel"])(
  "bounds failed attempts and honours cancellation: %s",
  async (failure) => {
    state.fail = failure;
    await expect(prepare()).rejects.toThrow();
    expect(state.attempts).toHaveLength(failure === "both" ? 2 : 1);
    expect(state.attempts.every((attempt) => attempt.disposed)).toBe(true);
  },
);
it("retains the qualified shared encoder without a second process", async () => {
  state.fail = "none";
  const result = await prepare();
  expect(state.attempts).toHaveLength(1);
  expect(result.reply.response.transport).toBe("nv12-shared");
  expect(result.reply.response.transport_reason).toBeNull();
});
