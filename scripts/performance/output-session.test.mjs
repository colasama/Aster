import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizePerformanceIdentity,
  PerformanceOutputSession,
  publishPerformanceReport,
  validatePerformanceResult,
  validateProbe,
} from "./output-session.mjs";

function fixture(mode = "ipc-no-encode") {
  return {
    case: { id: "tiny", size: { width: 2, height: 2 } },
    benchmark: {
      id: `tiny-${mode}-1`,
      mode,
      run: 1,
      warmupFrames: 10,
      startFrame: 12,
      endFrameExclusive: 14,
      frameRate: { numerator: 30, denominator: 1 },
    },
  };
}

function request(assignment, type, extra = {}) {
  return {
    type,
    jobId: assignment.benchmark.id,
    leaseId: `benchmark-${assignment.benchmark.run}`,
    outputId: "mp4",
    ...extra,
  };
}

const audio = { sampleRate: 48_000, channels: 2, frameCount: 3200 };
const identity = {
  vendor: "Test",
  architecture: "device",
  device: "id",
  description: "GPU",
  fonts: { status: "available", sha256: "a".repeat(64), count: 12 },
};

function harness(assignment, options = {}) {
  const calls = [];
  let start;
  const manager = {
    async start(value, owner) {
      calls.push(["start", value, owner]);
      start = value;
      return { jobId: "native-job", encoder: "libx264" };
    },
    async write(...args) {
      calls.push(["write", ...args]);
    },
    async writeAudio(...args) {
      calls.push(["writeAudio", ...args]);
    },
    async finish(...args) {
      calls.push(["finish", ...args]);
      return {
        jobId: "native-job",
        encoder: "libx264",
        outputPath: start.outputPath,
        frameCount: 2,
        audioFrameCount: start.audio?.frameCount ?? 0,
        bytesWritten: 99,
        elapsedMs: 12,
      };
    },
    async cancelOwner(owner) {
      calls.push(["cancelOwner", owner]);
    },
    ...options.manager,
  };
  const output = new PerformanceOutputSession(assignment, {
    ownerId: 7,
    runDirectory: options.directory ?? tmpdir(),
    index: 1,
    probe: async (...args) => {
      calls.push(["probe", ...args]);
      return { bytes: 99, sha256: "f".repeat(64) };
    },
    ...options,
    manager,
  });
  return { output, calls };
}

async function writeComplete(assignment, output, withAudio = false) {
  await output.output(
    request(assignment, "startMp4", {
      pixelFormat: "bgra",
      videoBitrateBps: 20_000_000,
      ...(withAudio ? { audio } : {}),
    }),
  );
  // Audio and video use separate pipes and must remain independently writable.
  await Promise.all([
    output.output(request(assignment, "writeMp4Frame", { pixels: new ArrayBuffer(16) })),
    withAudio
      ? output.output(
          request(assignment, "writeMp4Audio", { samples: new ArrayBuffer(audio.frameCount * 8) }),
        )
      : Promise.resolve(),
  ]);
  await output.output(request(assignment, "writeMp4Frame", { pixels: new ArrayBuffer(16) }));
  return output.output(request(assignment, "finishMp4"));
}

test("IPC-only acknowledges real ArrayBuffers and counts video without touching an encoder", async () => {
  const assignment = fixture();
  const { output, calls } = harness(assignment);
  await writeComplete(assignment, output);
  await output.verify();
  assert.deepEqual(calls, []);
  assert.equal(output.report.videoFrames, 2);
  assert.equal(output.report.videoBytes, 32);
  assert.equal(output.report.audioFrames, 0);
  assert.equal(output.report.audioBytes, 0);
  assert.equal(output.report.outputCalls, 4);
  assert.equal(output.report.encoder, null);
});

test("full export forwards original buffers and defers independent probing beyond finish ACK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-perf-output-"));
  try {
    const assignment = fixture("full-mp4");
    const { output, calls } = harness(assignment, { directory });
    const result = await writeComplete(assignment, output, true);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["start", "write", "writeAudio", "write", "finish"],
    );
    assert.equal(result.encoder, "libx264");
    assert.equal(calls[0][1].frameCount, 2);
    assert.equal(calls[0][1].frameRateNumerator, 30);
    assert.equal(calls[0][1].videoBitrateBps, 20_000_000);
    assert.equal(calls[1][1], "native-job");
    assert.ok(calls[1][2] instanceof ArrayBuffer);
    assert.equal(calls[1][3], 7);
    await output.verify();
    assert.equal(calls.at(-1)[0], "probe");
    const duplicate = harness(assignment, { directory });
    await assert.rejects(writeComplete(assignment, duplicate.output), /EEXIST/);
    assert.deepEqual(duplicate.calls, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readback-only forbids output IPC and mismatched lease cannot access a session", async () => {
  const assignment = fixture("readback-only");
  const { output } = harness(assignment);
  await assert.rejects(output.output(request(assignment, "startMp4")), /must not invoke/);
  const ipc = harness(fixture()).output;
  await assert.rejects(ipc.output({ type: "startMp4", jobId: "other" }), /active benchmark lease/);
  assert.throws(
    () => harness({ ...fixture(), benchmark: { ...fixture().benchmark, run: "../../outside" } }),
    /Invalid/,
  );
});

test("malformed, surplus, missing and post-failure frames cannot produce a valid output", async () => {
  for (const scenario of ["malformed", "missing", "surplus", "audio"]) {
    const assignment = fixture();
    const { output } = harness(assignment);
    await output.output(
      request(assignment, "startMp4", { pixelFormat: "rgba", videoBitrateBps: 20_000_000 }),
    );
    if (scenario === "malformed")
      await assert.rejects(
        output.output(request(assignment, "writeMp4Frame", { pixels: new Uint8Array(16) })),
        /packed/,
      );
    if (scenario === "missing")
      await assert.rejects(output.output(request(assignment, "finishMp4")), /missing/);
    if (scenario === "audio")
      await assert.rejects(
        output.output(request(assignment, "writeMp4Audio", { samples: new ArrayBuffer(8) })),
        /Audio IPC/,
      );
    if (scenario === "surplus") {
      for (let i = 0; i < 2; i++)
        await output.output(request(assignment, "writeMp4Frame", { pixels: new ArrayBuffer(16) }));
      await assert.rejects(
        output.output(request(assignment, "writeMp4Frame", { pixels: new ArrayBuffer(16) })),
        /Too many/,
      );
    }
    assert.throws(() => output.assertComplete());
    await assert.rejects(output.output(request(assignment, "finishMp4")));
  }
});

test("encoder errors and cancellation cannot be acknowledged as complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-perf-cancel-"));
  try {
    const assignment = fixture("full-mp4");
    const { output, calls } = harness(assignment, {
      directory,
      manager: {
        async write() {
          throw new Error("broken pipe");
        },
      },
    });
    await assert.rejects(writeComplete(assignment, output), /broken pipe/);
    await output.cancel();
    assert.equal(calls.at(-1)[0], "cancelOwner");
    assert.throws(() => output.assertComplete(), /broken pipe/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ffprobe validates the encoded stream rather than only trusting encoder counters", () => {
  const request = {
    width: 2,
    height: 2,
    frameCount: 2,
    frameRateNumerator: 30,
    frameRateDenominator: 1,
    audio,
  };
  const good = {
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 2,
        height: 2,
        nb_read_frames: "2",
        avg_frame_rate: "60/2",
        duration: "0.066667",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        duration: "0.066667",
      },
    ],
    format: { duration: "0.067" },
  };
  validateProbe(good, request);
  for (const mutate of [
    (value) => {
      value.streams[0].nb_read_frames = "1";
    },
    (value) => {
      value.streams[0].avg_frame_rate = "30000/1001";
    },
    (value) => {
      value.streams.pop();
    },
    (value) => {
      value.streams[1].sample_rate = "44100";
    },
    (value) => {
      value.streams[1].duration = "0.2";
    },
    (value) => {
      value.format.duration = "N/A";
    },
  ]) {
    const invalid = structuredClone(good);
    mutate(invalid);
    assert.throws(() => validateProbe(invalid, request), /FFprobe/);
  }
});

test("completion is bound to adapter, assignment, counted IPC and complete timing samples", async () => {
  const assignment = fixture();
  const { output } = harness(assignment);
  await writeComplete(assignment, output);
  const result = {
    schemaVersion: 1,
    id: assignment.benchmark.id,
    benchmarkId: assignment.benchmark.id,
    caseId: "tiny",
    mode: "ipc-no-encode",
    run: 1,
    frames: 2,
    warmupFrames: 10,
    startFrame: 12,
    endFrameExclusive: 14,
    width: 2,
    height: 2,
    frameRate: { numerator: 30, denominator: 1 },
    pixelFormat: "bgra",
    synchronizeVideo: false,
    maxInFlight: 2,
    elapsedMs: 100,
    framesPerSecond: 20,
    frameCompletionIntervalsMs: [10, 20],
    readbackWallLatenciesMs: [8, 9],
    outputInvokeLatenciesMs: ["startMp4", "writeMp4Frame", "writeMp4Frame", "finishMp4"].map(
      (type) => ({ type, elapsedMs: 1 }),
    ),
    audio: null,
    loadMs: 1,
    initializeMs: 1,
    diagnostics: { available: true, description: "Test · GPU" },
  };
  validatePerformanceResult(assignment, result, output.report, identity);
  for (const mutate of [
    (value) => {
      value.benchmarkId = "wrong";
    },
    (value) => {
      value.framesPerSecond = 21;
    },
    (value) => {
      value.frameCompletionIntervalsMs.pop();
    },
    (value) => {
      value.outputInvokeLatenciesMs.pop();
    },
    (value) => {
      value.diagnostics.description = "Other · GPU";
    },
    (value) => {
      value.diagnostics.precompositionSurfaceError = "missing surface";
    },
  ]) {
    const invalid = structuredClone(result);
    mutate(invalid);
    assert.throws(() => validatePerformanceResult(assignment, invalid, output.report, identity));
  }
});

test("font identity is normalized and invalid fingerprints fail closed", () => {
  assert.equal(normalizePerformanceIdentity(identity).fonts.sha256, "a".repeat(64));
  assert.deepEqual(
    normalizePerformanceIdentity({
      ...identity,
      fonts: { status: "unavailable", reason: "denied" },
    }).fonts,
    { status: "unavailable", reason: "denied" },
  );
  assert.throws(
    () =>
      normalizePerformanceIdentity({
        ...identity,
        fonts: { status: "available", sha256: "bad", count: 12 },
      }),
    /font/,
  );
});

test("owner audiovisual output cannot silently become video-only", async () => {
  const owner = fixture("full-mp4");
  owner.benchmark.requireAudio = true;
  await assert.rejects(
    harness(owner).output.output(
      request(owner, "startMp4", { pixelFormat: "bgra", videoBitrateBps: 20_000_000 }),
    ),
    /audio configuration/,
  );
  const ipc = fixture();
  await assert.rejects(
    harness(ipc).output.output(
      request(ipc, "startMp4", { pixelFormat: "bgra", videoBitrateBps: 20_000_000, audio }),
    ),
    /audio configuration/,
  );
});

test("cancelled pending encoder writes never advance counters or allow completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-perf-pending-"));
  try {
    const assignment = fixture("full-mp4");
    let resolveWrite;
    const pending = new Promise((resolve) => {
      resolveWrite = resolve;
    });
    const { output } = harness(assignment, { directory, manager: { write: () => pending } });
    await output.output(
      request(assignment, "startMp4", { pixelFormat: "rgba", videoBitrateBps: 20_000_000 }),
    );
    const write = output.output(
      request(assignment, "writeMp4Frame", { pixels: new ArrayBuffer(16) }),
    );
    await output.cancel();
    resolveWrite();
    await assert.rejects(write, /expired/);
    assert.equal(output.report.videoFrames, 0);
    assert.throws(() => output.assertComplete(), /expired/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed serialization cleans staging and competing publishers cannot replace evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-perf-atomic-"));
  try {
    const circular = {};
    circular.self = circular;
    await assert.rejects(publishPerformanceReport(directory, circular), /circular/i);
    assert.deepEqual(await readdir(directory), []);
    const results = await Promise.allSettled([
      publishPerformanceReport(directory, { marker: "a" }),
      publishPerformanceReport(directory, { marker: "b" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.deepEqual(await readdir(directory), ["report.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report publication is atomic and never overwrites previous evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-perf-report-"));
  try {
    await publishPerformanceReport(directory, { status: "failed", cases: [] });
    assert.deepEqual(JSON.parse(await readFile(join(directory, "report.json"), "utf8")), {
      status: "failed",
      cases: [],
    });
    await assert.rejects(
      publishPerformanceReport(directory, { status: "passed" }),
      /already exists/,
    );
    await writeFile(join(directory, "unrelated"), "preserved");
    assert.equal(await readFile(join(directory, "unrelated"), "utf8"), "preserved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
