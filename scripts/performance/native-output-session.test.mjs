import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NativePerformanceOutputSession } from "./native-output-session.mjs";

test("native observations require warm-up, actual output counts and a complete measured interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-native-observation-"));
  try {
    const assignment = {
      case: { id: "composite-1080p", size: { width: 2, height: 2 }, aa: "off" },
      benchmark: {
        id: "native-test",
        renderer: "rust",
        mode: "full-mp4",
        run: 1,
        startFrame: 0,
        endFrameExclusive: 2,
        frameRate: { numerator: 30, denominator: 1 },
      },
    };
    class Host {
      constructor(options) {
        this.options = options;
      }
      async warm() {
        return { accepted: true, reason: null };
      }
      async output(request) {
        if (request.type === "admitNative") await delay(10);
        if (request.type === "sealNative")
          this.options.report({ accepted: true, reason: null }, { warmup: { frames: 10 } });
        return {
          handled: true,
          value:
            request.type === "finishMp4"
              ? {
                  frameCount: 2,
                  encoder: "h264_mf",
                  nativeEncoder: { accepted_frames: 2, encoded_frames: 2, drain_completed: true },
                }
              : ["prepareNative", "admitNative", "sealNative"].includes(request.type)
                ? { accepted: true, reason: null }
                : undefined,
        };
      }
    }
    const session = new NativePerformanceOutputSession(assignment, {
      NativeRenderHostExport: Host,
      parseRenderHostOutputRequest: (value) => value,
      runDirectory: directory,
      index: 1,
      allowedAssets: new Map(),
      runtime: {},
    });
    const manifest = {
      id: "native-test",
      projectRevision: 0,
      width: 2,
      height: 2,
      antiAliasing: "off",
      startFrame: 0,
      endFrameExclusive: 2,
      frameRate: assignment.benchmark.frameRate,
      compositionId: "root",
      projectSnapshot: JSON.stringify({ compositions: [{ id: "root" }] }),
      renderMediaSnapshot: "{}",
      outputs: [
        {
          id: "mp4",
          kind: "mp4",
          destination: "native-test.mp4",
          codec: "h264",
          bitrateMbps: 20,
          includeAudio: true,
        },
      ],
    };
    await session.prepare(manifest);
    const send = (type) =>
      session.output({
        type,
        jobId: "native-test",
        leaseId: "benchmark-1",
        outputId: "mp4",
        ...(type === "startMp4" ? { videoBitrateBps: 20_000_000 } : {}),
      });
    await assert.rejects(send("prepareNative"));
    for (let index = 0; index < 10; index++) await session.warm(index % 2, {});
    await send("prepareNative");
    await assert.rejects(send("writeMp4Frame"), /fallback or write raw/);
    await assert.rejects(
      session.output({
        type: "abandonNative",
        jobId: "native-test",
        leaseId: "benchmark-1",
        outputId: "mp4",
        reason: "Native frame preparation: source decode failed",
      }),
      /abandonNative: Native frame preparation: source decode failed/,
    );
    for (const type of [
      "admitNative",
      "admitNative",
      "sealNative",
      "startMp4",
      "renderNativeFrame",
      "renderNativeFrame",
      "finishMp4",
    ])
      await send(type);
    const elapsedMs = session.report.observedWorkMs + 10;
    const result = {
      schemaVersion: 1,
      renderer: "rust",
      id: "native-test",
      benchmarkId: "native-test",
      caseId: "composite-1080p",
      mode: "full-mp4",
      run: 1,
      frames: 2,
      startFrame: 0,
      endFrameExclusive: 2,
      width: 2,
      height: 2,
      frameRate: manifest.frameRate,
      warmupFrames: 10,
      maxInFlight: 1,
      pixelFormat: "rgba",
      synchronizeVideo: false,
      elapsedMs,
      framesPerSecond: 2000 / elapsedMs,
      loadMs: 0,
      initializeMs: 0,
      frameCompletionIntervalsMs: [0, 0],
      planWallLatenciesMs: [0, 0],
      outputInvokeLatenciesMs: session.report.calls.map((type) => ({ type, elapsedMs: 0 })),
      audio: null,
      diagnostics: { available: true, description: "GPU · WebGPU" },
    };
    session.validate(result, {});
    assert.throws(
      () => session.validate({ ...result, elapsedMs: 1, framesPerSecond: 2000 }, {}),
      /omitted observed/,
    );
    assert.throws(() => session.validate({ ...result, renderer: "ts" }, {}));
    assert.throws(() => session.validate({ ...result, planWallLatenciesMs: [0] }, {}));
    assert.throws(() => session.validate({ ...result, outputInvokeLatenciesMs: [] }, {}));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
