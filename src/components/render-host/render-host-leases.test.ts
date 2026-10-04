import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlankProject } from "../../core/project/project";
import { FrameBufferPool } from "../../core/rendering/frame-buffer-pool";
import type { DesktopRenderHostAssignment } from "../../desktop/api";
import { runRenderHostFrameLoop, validateRenderHostAssignment } from "./render-host-session";

afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture(frameCount = 9) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = 16;
  composition.height = 16;
  const work: DesktopRenderHostAssignment = {
    jobId: "leased-job",
    leaseId: "lease",
    manifest: {
      id: "leased-job",
      compositionId: composition.id,
      compositionName: composition.name,
      projectRevision: 3,
      projectSnapshot: JSON.stringify(project),
      width: 16,
      height: 16,
      frameRate: composition.frameRate,
      startFrame: 0,
      endFrameExclusive: frameCount,
      priority: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
      outputs: [
        {
          id: "video",
          kind: "mp4",
          destination: "C:/renders/leased.mp4",
          codec: "h264",
          bitrateMbps: 16,
          includeAudio: false,
        },
      ],
    },
  };
  const options: Parameters<typeof runRenderHostFrameLoop>[0] = {
    assignment: validateRenderHostAssignment(work),
    pixelFormat: "rgba",
    maxInFlightFrames: 3,
    requestedControl: () => undefined,
    renderFrame: vi.fn(async (frame: number) => ({
      pixels: new Uint8Array(16 * 16 * 4).fill(frame + 1).buffer,
      pixelFormat: "rgba" as const,
    })),
    encodePng: async (raw) => raw.pixels.slice(0, 8),
    output: async () => undefined,
    report: async () => undefined,
  };
  return { options, work };
}

function observeLeases() {
  const acquire = FrameBufferPool.prototype.acquire;
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  vi.spyOn(FrameBufferPool.prototype, "acquire").mockImplementation(function (
    this: FrameBufferPool,
  ) {
    const lease = acquire.call(this);
    const release = vi.fn(() => lease.release());
    releases.push(release);
    return {
      get buffer() {
        return lease.buffer;
      },
      release,
    };
  });
  return releases;
}

describe("RenderHost leased destinations", () => {
  it("keeps the default backend's returned buffers independently owned", async () => {
    const { options } = fixture(6);
    const acquire = vi.spyOn(FrameBufferPool.prototype, "acquire");
    const frames: ArrayBuffer[] = [];
    options.output = async (request) => {
      if (request.type === "writeMp4Frame") frames.push(request.pixels);
    };
    expect(await runRenderHostFrameLoop(options)).toBe("completed");
    expect(acquire).not.toHaveBeenCalled();
    expect(new Set(frames).size).toBe(6);
    expect(frames.map((buffer) => new Uint8Array(buffer)[0])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each([
    [3, 4],
    [99, 4],
    [Number.NaN, 2],
    [0, 2],
  ])("reuses at most the actual clamped window plus one (%s => %s)", async (depth, capacity) => {
    const { options } = fixture();
    options.maxInFlightFrames = depth;
    const destinations = new Set<ArrayBuffer>();
    const values: number[] = [];
    options.renderFrameInto = async (frame, _time, destination) => {
      destinations.add(destination);
      new Uint8Array(destination).fill(frame + 1);
      return { pixels: destination, pixelFormat: "rgba" };
    };
    options.output = async (request) => {
      if (request.type === "writeMp4Frame") values.push(new Uint8Array(request.pixels)[0]);
    };
    expect(await runRenderHostFrameLoop(options)).toBe("completed");
    expect(options.renderFrame).not.toHaveBeenCalled();
    expect(destinations.size).toBe(capacity);
    expect(values).toEqual(Array.from({ length: 9 }, (_, index) => index + 1));
  });

  it("retains a frame through PNG and every MP4 acknowledgment before reuse", async () => {
    const { options, work } = fixture();
    const firstOutput = work.manifest.outputs[0];
    if (firstOutput.kind !== "mp4") throw new Error("Fixture must contain MP4 output");
    work.manifest.outputs.push({
      ...firstOutput,
      id: "second",
      destination: "C:/renders/second.mp4",
    });
    work.manifest.outputs.push({
      id: "png",
      kind: "pngSequence",
      destination: "C:/renders/png",
      fileNamePattern: "[######].png",
    });
    const blocked = signal();
    const acknowledge = signal();
    const releases = observeLeases();
    const destinations: ArrayBuffer[] = [];
    const values: number[] = [];
    options.renderFrameInto = async (frame, _time, destination) => {
      destinations.push(destination);
      new Uint8Array(destination).fill(frame + 1);
      return { pixels: destination, pixelFormat: "rgba" };
    };
    options.output = async (request) => {
      if (request.type === "writeMp4Frame") {
        const initial = new Uint8Array(request.pixels)[0];
        if (initial === 1 && request.outputId === "second") {
          blocked.resolve();
          await acknowledge.promise;
          expect(new Uint8Array(request.pixels)[0]).toBe(1);
        }
        values.push(initial);
      }
    };
    const result = runRenderHostFrameLoop(options);
    await blocked.promise;
    expect(destinations).toHaveLength(4);
    expect(releases.every((release) => release.mock.calls.length === 0)).toBe(true);
    acknowledge.resolve();
    expect(await result).toBe("completed");
    expect(values).toEqual(Array.from({ length: 9 }, (_, index) => [index + 1, index + 1]).flat());
    expect(new Set(destinations).size).toBe(4);
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["render", "detached-render", "wrong-destination", "output", "cancel"] as const)(
    "returns every acquired lease on %s termination",
    async (failure) => {
      const { options } = fixture();
      const releases = observeLeases();
      let cancelled = false;
      options.requestedControl = () => (cancelled ? "cancel" : undefined);
      options.renderFrameInto = async (frame, _time, destination) => {
        if (failure === "detached-render" && frame === 0) {
          structuredClone(destination, { transfer: [destination] });
          throw new Error("render rejected");
        }
        if (failure === "render" && frame === 0) throw new Error("render rejected");
        return {
          pixels:
            failure === "wrong-destination" && frame === 0 ? destination.slice(0) : destination,
          pixelFormat: "rgba",
        };
      };
      options.output = async (request) => {
        if (request.type !== "writeMp4Frame") return;
        if (failure === "output") throw new Error("output rejected");
        if (failure === "cancel") cancelled = true;
      };
      if (failure === "cancel") expect(await runRenderHostFrameLoop(options)).toBe("cancelled");
      else
        await expect(runRenderHostFrameLoop(options)).rejects.toThrow(
          failure === "wrong-destination"
            ? "leased frame destination"
            : failure === "detached-render"
              ? "render rejected"
              : `${failure} rejected`,
        );
      expect(releases.length).toBeGreaterThan(1);
      for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
    },
  );
});
