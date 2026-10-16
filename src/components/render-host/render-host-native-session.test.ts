import { describe, expect, it, vi } from "vitest";
import { parseRenderHostOutputRequest } from "../../../electron/render-queue-host-protocol";
import { createBlankProject } from "../../core/project/project";
import type { NativeFramePacket } from "../../core/rendering/native-export-protocol";
import type { DesktopRenderHostOutputRequest, DesktopRenderHostReport } from "../../desktop/api";
import { nativeFramePacket } from "../../renderer/compositing/native-frame-packet";
import { frameBundleFixtures } from "../../renderer/frame-plan/frame-bundle-fixture";
import { preflightNativeRenderHost } from "./render-host-native-preflight";
import {
  type RenderHostFrameLoopOptions,
  runRenderHostFrameLoop,
  validateRenderHostAssignment,
} from "./render-host-session";

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = 64;
  composition.height = 64;
  composition.frameRate = { numerator: 30, denominator: 1 };
  const assignment = validateRenderHostAssignment({
    jobId: "job",
    leaseId: "lease",
    manifest: {
      id: "job",
      compositionId: composition.id,
      compositionName: composition.name,
      projectRevision: 3,
      projectSnapshot: JSON.stringify(project),
      width: 64,
      height: 64,
      frameRate: composition.frameRate,
      startFrame: 0,
      endFrameExclusive: 3,
      priority: 1,
      createdAt: new Date(0).toISOString(),
      outputs: [
        {
          id: "video",
          kind: "mp4",
          codec: "h264",
          bitrateMbps: 8,
          includeAudio: false,
          destination: "C:\\renders\\output.mp4",
        },
      ],
    },
  });
  const outputs: DesktopRenderHostOutputRequest[] = [],
    reports: DesktopRenderHostReport[] = [];
  const events: string[] = [];
  const planFrame = vi.fn(async (frame: number): Promise<NativeFramePacket> => {
    events.push(`plan:${frame}`);
    return { plan: new ArrayBuffer(32), resources: [] };
  });
  const renderFrame = vi.fn(async () => ({
    pixels: new ArrayBuffer(64 * 64 * 4),
    pixelFormat: "rgba" as const,
    bytesPerRow: 256,
  }));
  const options: RenderHostFrameLoopOptions = {
    assignment,
    pixelFormat: "rgba",
    requestedControl: () => undefined,
    planFrame,
    renderFrame,
    encodePng: async () => {
      throw new Error("Native export must not read pixels");
    },
    output: async (request) => {
      parseRenderHostOutputRequest(request);
      outputs.push(request);
      events.push(request.type);
      return { accepted: true, reason: null };
    },
    report: async (report) => {
      reports.push(report);
    },
  };
  return { options, outputs, reports, events, renderFrame, planFrame };
}

describe("whole-job native render host routing", () => {
  it("passes the preceding closure into capture and carries references across successive frames", async () => {
    const f = fixture();
    const bundle = frameBundleFixtures()[1].frameBundle;
    const windows: string[][] = [];
    f.options.planFrame = async (_frame, _time, retained) => {
      windows.push([...(retained ?? [])]);
      return nativeFramePacket(bundle, retained);
    };
    await preflightNativeRenderHost(f.options);
    const hashes = bundle.resources.map((resource) => resource.message.hash);
    expect(windows).toEqual([[], hashes, hashes]);
    const admissions = f.outputs.filter((request) => request.type === "admitNative");
    expect(admissions).toHaveLength(3);
    expect(admissions[0].packet.resources).toHaveLength(hashes.length);
    for (const request of admissions.slice(1)) {
      expect(request.packet.resources).toEqual([]);
      expect(request.packet.retainedResources).toEqual(hashes);
    }
  });

  it("sends content references only while resources remain in the preceding accepted frame", async () => {
    const f = fixture();
    f.options.assignment.manifest.endFrameExclusive = 4;
    f.options.planFrame = async (index) => ({
      plan: new ArrayBuffer(32),
      resources: [
        {
          message: {
            type: "put_resource",
            hash: (index === 2 ? "2" : "1").repeat(64),
            kind: "buffer",
            descriptor: { element_type: "u8", element_count: 16, byte_length: 16 },
          },
          bytes: new ArrayBuffer(16),
        },
      ],
    });
    expect(await preflightNativeRenderHost(f.options)).toEqual({
      active: true,
      prepared: true,
      cancelled: false,
    });
    const packets = f.outputs
      .filter((request) => request.type === "admitNative")
      .map((request) => request.packet);
    expect(packets.map((packet) => packet.resources.length)).toEqual([1, 0, 1, 1]);
    expect(packets.map((packet) => packet.retainedResources)).toEqual([
      undefined,
      ["1".repeat(64)],
      undefined,
      undefined,
    ]);
  });
  it("admits every frame before starting output and never invokes the TS output graph", async () => {
    const f = fixture();
    expect(await runRenderHostFrameLoop(f.options)).toBe("completed");
    expect(f.events).toEqual([
      "prepareNative",
      "plan:0",
      "admitNative",
      "plan:1",
      "admitNative",
      "plan:2",
      "admitNative",
      "sealNative",
      "startMp4",
      "renderNativeFrame",
      "renderNativeFrame",
      "renderNativeFrame",
      "finishMp4",
    ]);
    expect(f.renderFrame).not.toHaveBeenCalled();
    expect(f.reports.filter((r) => r.type === "prepared")).toHaveLength(1);
    expect(
      f.reports.filter((r) => r.type === "progress").map((r) => r.progress.completedFrames),
    ).toEqual([1, 2, 3]);
  });
  it("restarts the complete job in TS when one later frame fails native admission", async () => {
    const f = fixture(),
      output = f.options.output;
    f.options.output = async (request) => {
      await output(request);
      return request.type === "admitNative" && request.frame === 1
        ? { accepted: false, reason: "Unsupported plan" }
        : { accepted: true, reason: null };
    };
    expect(await runRenderHostFrameLoop(f.options)).toBe("completed");
    expect(f.planFrame).toHaveBeenCalledTimes(3);
    expect(f.renderFrame).toHaveBeenCalledTimes(3);
    expect(f.outputs.some((r) => r.type === "sealNative" || r.type === "renderNativeFrame")).toBe(
      false,
    );
    expect(f.reports.filter((r) => r.type === "prepared")).toHaveLength(1);
  });
  it("abandons partial native inputs with a concrete capture failure reason", async () => {
    const f = fixture();
    f.options.planFrame = async () => {
      throw new Error("unsupported raster source");
    };
    expect(await runRenderHostFrameLoop(f.options)).toBe("completed");
    expect(f.outputs.find((r) => r.type === "abandonNative")).toMatchObject({
      reason: "Native frame preparation: unsupported raster source",
    });
    expect(f.renderFrame).toHaveBeenCalledTimes(3);
  });
  it.each(["pause", "cancel"] as const)(
    "honors %s during preflight before any output opens",
    async (control) => {
      const f = fixture();
      let requested: "pause" | "cancel" | undefined;
      f.options.requestedControl = () => requested;
      const output = f.options.output,
        report = f.options.report;
      f.options.output = async (request) => {
        const result = await output(request);
        if (request.type === "admitNative" && request.frame === 0) requested = control;
        return result;
      };
      f.options.report = async (event) => {
        await report(event);
        if (event.type === "paused") requested = undefined;
      };
      expect(await runRenderHostFrameLoop(f.options)).toBe(
        control === "cancel" ? "cancelled" : "completed",
      );
      expect(f.renderFrame).not.toHaveBeenCalled();
      if (control === "pause") expect(f.reports.some((r) => r.type === "paused")).toBe(true);
      else {
        expect(f.planFrame).toHaveBeenCalledTimes(2);
        expect(f.outputs.some((r) => r.type === "startMp4")).toBe(false);
      }
    },
  );

  it("prepares at most one owned frame ahead while admission is pending", async () => {
    const f = fixture();
    const gate = signal();
    const output = f.options.output;
    f.options.output = async (request) => {
      const value = await output(request);
      if (request.type === "admitNative" && request.frame === 0) await gate.promise;
      return value;
    };
    const pending = preflightNativeRenderHost(f.options);
    await vi.waitFor(() => expect(f.planFrame).toHaveBeenCalledTimes(2));
    expect(f.outputs.filter((r) => r.type === "admitNative")).toHaveLength(1);
    expect(f.outputs.some((r) => r.type === "sealNative")).toBe(false);
    gate.resolve();
    expect(await pending).toEqual({ active: true, prepared: true, cancelled: false });
    expect(f.planFrame.mock.calls.map(([frame]) => frame)).toEqual([0, 1, 2]);
    expect(f.outputs.filter((r) => r.type === "admitNative").map((r) => r.frame)).toEqual([
      0, 1, 2,
    ]);
  });

  it("drains admission before abandoning a failed speculative capture", async () => {
    const f = fixture();
    const gate = signal();
    const output = f.options.output;
    f.options.output = async (request) => {
      const value = await output(request);
      if (request.type === "admitNative") await gate.promise;
      return value;
    };
    f.planFrame.mockImplementation(async (frame) => {
      if (frame === 1) throw new Error("raster failed");
      return { plan: new ArrayBuffer(32), resources: [] };
    });
    const pending = preflightNativeRenderHost(f.options);
    await vi.waitFor(() => expect(f.planFrame).toHaveBeenCalledTimes(2));
    expect(f.outputs.some((r) => r.type === "abandonNative")).toBe(false);
    gate.resolve();
    expect(await pending).toEqual({ active: false, prepared: true, cancelled: false });
    expect(f.outputs[f.outputs.length - 1]).toMatchObject({
      type: "abandonNative",
      reason: "Native frame preparation: raster failed",
    });
    expect(f.outputs.filter((r) => r.type === "admitNative")).toHaveLength(1);
  });

  it.each(["cancel", "rejection", "pause"] as const)(
    "drains a pending capture before handling %s from the other lane",
    async (outcome) => {
      const f = fixture();
      const gate = signal();
      let control: "pause" | "cancel" | undefined;
      f.options.requestedControl = () => control;
      f.planFrame.mockImplementation(async (frame) => {
        if (frame === 1) await gate.promise;
        return { plan: new ArrayBuffer(32), resources: [] };
      });
      const output = f.options.output;
      f.options.output = async (request) => {
        const value = await output(request);
        if (request.type === "admitNative" && request.frame === 0) {
          if (outcome === "rejection") throw new Error("pipe closed");
          control = outcome;
        }
        return value;
      };
      const report = f.options.report;
      f.options.report = async (event) => {
        await report(event);
        if (event.type === "paused") control = undefined;
      };
      let settled = false;
      const pending = preflightNativeRenderHost(f.options).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      await vi.waitFor(() => expect(f.planFrame).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
      expect(f.reports.some((r) => r.type === "paused")).toBe(false);
      gate.resolve();
      const result = await pending;
      if (outcome === "rejection") expect(result).toEqual({ error: new Error("pipe closed") });
      else
        expect(result).toEqual({
          value: { active: outcome === "pause", prepared: true, cancelled: outcome === "cancel" },
        });
      expect(f.planFrame).toHaveBeenCalledTimes(outcome === "pause" ? 3 : 2);
      expect(f.outputs.some((r) => r.type === "sealNative")).toBe(outcome === "pause");
    },
  );
});
