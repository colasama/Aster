import { describe, expect, it, vi } from "vitest";
import type { GpuDiagnostics } from "../../src/core/types";
import { normalizeRawFrameRgba } from "../../src/renderer/gpu/raw-frame-png";
import { CaptureHealth } from "./capture-health";
import type { ParityCaptureApi, ParityCaptureAssignment } from "./capture-protocol";
import { type CaptureSession, runCaptureAssignments } from "./capture-runner";
import { captureSnapshotIdentity } from "./capture-snapshot";
import { caseFor, fixture } from "./generators/base";

function scenario(id: string, frames = [1, 0, 2]) {
  const { project, composition } = fixture(id);
  composition.frameRate = { numerator: 24000, denominator: 1001 };
  const generated = caseFor(id, project, [], { size: { width: 2, height: 1 } });
  const assignment: ParityCaptureAssignment = {
    case: generated.case,
    frames,
    projectPath: `D:/fixtures/${id}/project.json`,
    caseHash: "a".repeat(64),
  };
  const diagnostics: GpuDiagnostics = {
    available: true,
    adapter: "test",
    architecture: "test",
    description: "test",
    maxTextureSize: 8192,
    timestampQueries: false,
  };
  const session: CaptureSession = {
    composition,
    load_ms: 1,
    initialize_ms: 2,
    diagnostics: () => diagnostics,
    assertHealthy: vi.fn(),
    readback: vi.fn(async () => new ArrayBuffer(8)),
    dispose: vi.fn(async () => undefined),
  };
  return { assignment, session };
}

function apiFor(assignments: ParityCaptureAssignment[]): ParityCaptureApi {
  let index = 0;
  return {
    ready: vi.fn(async () => undefined),
    take: vi.fn(async () => assignments[index++] ?? null),
    frame: vi.fn(async () => undefined),
    completeCase: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    done: vi.fn(async () => undefined),
  };
}

describe("ordered reference capture", () => {
  it("scopes immutable initial revisions to exact inputs independently of frame addresses", () => {
    const first = captureSnapshotIdentity("a".repeat(64));
    expect(first.projectRevision).toBe(0);
    expect(captureSnapshotIdentity("a".repeat(64))).toEqual(first);
    expect(captureSnapshotIdentity("b".repeat(64)).snapshotScope).not.toBe(first.snapshotScope);
    expect(() => captureSnapshotIdentity("missing")).toThrow("input SHA-256");
  });

  it("retains reverse seeks and appended neighbors with exact rational timestamps", async () => {
    const { assignment, session } = scenario("order", [20, 0, 19, 21]);
    const api = apiFor([assignment]);
    await runCaptureAssignments(api, { open: async () => session });
    const captured = vi.mocked(api.frame).mock.calls.map(([frame]) => frame);
    expect(captured.map((frame) => frame.frame)).toEqual([20, 0, 19, 21]);
    expect(captured.map((frame) => frame.time)).toEqual(
      [20, 0, 19, 21].map((frame) => (frame * 1001) / 24000),
    );
    expect(captured.every((frame) => frame.pixels.byteLength === 8)).toBe(true);
    expect(vi.mocked(session.dispose).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.completeCase).mock.invocationCallOrder[0],
    );
    expect(api.fail).not.toHaveBeenCalled();
    expect(api.done).toHaveBeenCalledOnce();
  });

  it.each(["rgba", "bgra"] as const)(
    "awaits publication before reusing %s readback storage and keeps published RGBA independent",
    async (pixelFormat) => {
      const { assignment, session } = scenario("leased-readback", [2, 0]);
      const destination = new ArrayBuffer(8);
      const source = new Uint8Array(destination);
      let readbacks = 0;
      session.readback = vi.fn(async () => {
        const red = ++readbacks * 10;
        source.set(
          pixelFormat === "rgba"
            ? [red, 2, 3, 255, red, 5, 6, 128]
            : [3, 2, red, 255, 6, 5, red, 128],
        );
        return normalizeRawFrameRgba({ pixels: destination, pixelFormat }, 2, 1).buffer;
      });
      const api = apiFor([assignment]);
      let acknowledge!: () => void;
      const acknowledgement = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const submitted = new Promise<void>((resolve) => {
        api.frame = vi.fn(async (frame) => {
          if (frame.frame !== 2) return;
          resolve();
          await acknowledgement;
          expect([...new Uint8Array(frame.pixels)]).toEqual([10, 2, 3, 255, 10, 5, 6, 128]);
        });
      });
      const capture = runCaptureAssignments(api, { open: async () => session });
      await submitted;
      await Promise.resolve();
      expect(session.readback).toHaveBeenCalledOnce();
      expect(api.completeCase).not.toHaveBeenCalled();
      expect(session.dispose).not.toHaveBeenCalled();
      acknowledge();
      await capture;

      const frames = vi.mocked(api.frame).mock.calls.map(([frame]) => frame);
      expect(frames.map((frame) => frame.frame)).toEqual([2, 0]);
      expect(frames[0].pixels).not.toBe(destination);
      expect(frames[1].pixels).not.toBe(destination);
      expect(frames[0].pixels).not.toBe(frames[1].pixels);
      source.fill(99);
      expect([...new Uint8Array(frames[0].pixels)]).toEqual([10, 2, 3, 255, 10, 5, 6, 128]);
      expect([...new Uint8Array(frames[1].pixels)]).toEqual([20, 2, 3, 255, 20, 5, 6, 128]);
      expect(api.fail).not.toHaveBeenCalled();
      expect(api.completeCase).toHaveBeenCalledOnce();
    },
  );

  it("stops reusing the case destination after a failed publication acknowledgement", async () => {
    const { assignment, session } = scenario("rejected-ack", [0, 1]);
    const api = apiFor([assignment]);
    api.frame = vi.fn(async () => {
      throw new Error("Frame publication failed");
    });

    await runCaptureAssignments(api, { open: async () => session });

    expect(session.readback).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(api.completeCase).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith({
      caseId: assignment.case.id,
      error: expect.stringContaining("Frame publication failed"),
    });
  });

  it("rejects a pixel-sized frame with failed resources before publishing and continues independently", async () => {
    const first = scenario("broken");
    const second = scenario("healthy", [0]);
    const health = new CaptureHealth();
    first.session.readback = async () => {
      health.observe({ level: "warn", scope: "webgpu", event: "scene_generator_unavailable" });
      return new ArrayBuffer(8);
    };
    first.session.assertHealthy = () => health.assertHealthy();
    const api = apiFor([first.assignment, second.assignment]);
    await runCaptureAssignments(
      api,
      {
        open: async (assignment) =>
          assignment.case.id === "broken" ? first.session : second.session,
      },
      health,
    );
    expect(vi.mocked(api.frame).mock.calls.map(([frame]) => frame.caseId)).toEqual(["healthy"]);
    expect(api.fail).toHaveBeenCalledWith(expect.objectContaining({ caseId: "broken" }));
    expect(api.completeCase).toHaveBeenCalledOnce();
    expect(first.session.dispose).toHaveBeenCalledOnce();
  });

  it("rejects truncated readback and cleanup failure rather than completing the case", async () => {
    const { assignment, session } = scenario("truncated", [0]);
    session.readback = async () => new ArrayBuffer(4);
    session.dispose = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const api = apiFor([assignment]);
    await runCaptureAssignments(api, { open: async () => session });
    const failure = vi.mocked(api.fail).mock.calls[0][0].error;
    expect(failure).toContain("invalid RGBA byte length");
    expect(failure).toContain("cleanup failed");
    expect(api.frame).not.toHaveBeenCalled();
    expect(api.completeCase).not.toHaveBeenCalled();
  });

  it("stops assigning work after device loss", async () => {
    const first = scenario("lost");
    const second = scenario("unstarted");
    const health = new CaptureHealth();
    const api = apiFor([first.assignment, second.assignment]);
    await runCaptureAssignments(
      api,
      {
        async open() {
          health.observe({ level: "warn", scope: "webgpu", event: "device_lost" });
          throw new Error("device lost");
        },
      },
      health,
    );
    expect(api.take).toHaveBeenCalledOnce();
    expect(api.fail).toHaveBeenCalledOnce();
    expect(api.done).toHaveBeenCalledOnce();
  });
});
