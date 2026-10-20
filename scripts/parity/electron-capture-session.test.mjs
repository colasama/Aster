import assert from "node:assert/strict";
import test from "node:test";
import { CaptureSession, captureLogIsFailure } from "./electron-capture-session.mjs";
import { captureHostInfo } from "./electron-host-info.mjs";

const identity = {
  vendor: "Test vendor",
  architecture: "test-architecture",
  device: "test-device",
  description: "Test GPU",
  fonts: { status: "available", sha256: "a".repeat(64), count: 2 },
};
const diagnostics = { available: true, description: "Test vendor · Test GPU" };

function assignment(id) {
  return {
    case: { id, size: { width: 2, height: 1 } },
    frames: [0, 3],
    projectPath: `/fixtures/${id}.json`,
  };
}

function harness(assignments, options = {}) {
  const calls = [];
  const store = {
    cached: async (item) => {
      calls.push(["cached", item.case.id]);
      return options.cached?.(item) ?? false;
    },
    writeFrame: async (item, frame) => {
      calls.push(["frame", item.case.id, frame.frame]);
    },
    completeCase: async (item) => {
      calls.push(["complete", item.case.id]);
    },
    finish: async (report) => {
      calls.push(["finish", report.status]);
    },
    ...options.store,
  };
  const host = captureHostInfo({ gpuDevice: [] }, {});
  const session = new CaptureSession(
    {
      runId: "test",
      assignments,
      timeoutMs: options.timeoutMs ?? 1000,
      planReferences: options.planReferences,
    },
    host,
    store,
    {
      prepare: async (item) => {
        calls.push(["prepare", item.case.id]);
      },
    },
    { print() {}, recover: options.recover, fatal: options.fatal },
  );
  return { session, calls, host };
}

function frame(caseId, index = 0) {
  return { caseId, frame: index, width: 2, height: 1, pixels: new ArrayBuffer(8), diagnostics };
}

test("actual adapter and font identity precede every cache lookup", async () => {
  const { session, calls, host } = harness([assignment("first")]);
  await assert.rejects(session.take(), /readiness/);
  assert.deepEqual(calls, []);
  session.ready(identity);
  assert.equal(host.cacheIdentity.webgpuAdapter.architecture, "test-architecture");
  assert.equal(host.cacheIdentity.backend, "browser-webgpu");
  assert.equal(host.cacheIdentity.fonts.sha256, identity.fonts.sha256);
  assert.throws(() => session.ready({ ...identity, device: "other-device" }), /changed/);
  await session.take();
  await session.abort(new Error("test complete"));
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("top-level failure aborts the active case and every remaining assignment", async () => {
  const { session } = harness([assignment("active"), assignment("remaining")]);
  session.ready(identity);
  await session.take();
  await session.fail({ error: "Top-level capture failure" });
  const report = await session.done();
  assert.equal(report.status, "failed");
  assert.deepEqual(
    report.cases.map((item) => item.status),
    ["failed", "skipped"],
  );
  assert.match(report.error, /Top-level capture failure/);
});

test("GPU loss between assignments rejects into the main process shutdown handler", async () => {
  const { session } = harness([assignment("first"), assignment("next")]);
  session.ready(identity);
  await session.take();
  await session.fail({ caseId: "first", error: "case failure" });
  await assert.rejects(session.rendererLost(new Error("GPU process exited")), /GPU process exited/);
  const report = await session.abort(new Error("GPU process exited"));
  assert.deepEqual(
    report.cases.map((item) => item.status),
    ["failed", "skipped"],
  );
});

test("error diagnostics between cases request shutdown and preserve a failed report", async () => {
  const { session } = harness([assignment("first"), assignment("remaining")]);
  session.ready(identity);
  await session.take();
  await session.frame(frame("first"));
  await session.frame(frame("first", 3));
  await session.completeCase({ caseId: "first", diagnostics });
  const error = session.log({
    level: "error",
    scope: "webgpu",
    message: "GPU error between cases",
  });
  assert(error instanceof Error);
  assert.equal(session.report.status, "failed");
  const report = await session.abort(error);
  assert.deepEqual(
    report.cases.map((item) => item.status),
    ["passed", "skipped"],
  );
});

test("error diagnostics after the last completion cannot pass the final font-check interval", async () => {
  const { session } = harness([assignment("last")]);
  session.ready(identity);
  await session.take();
  await session.frame(frame("last"));
  await session.frame(frame("last", 3));
  await session.completeCase({ caseId: "last", diagnostics });
  assert.equal(session.log({ level: "warn", event: "cache_budget" }), undefined);
  assert.equal(session.report.status, "passed");
  const error = session.log({ level: "error", event: "device_lost", message: "Late device loss" });
  assert(error instanceof Error);
  const report = await session.done();
  assert.equal(report.status, "failed");
  assert.match(report.error, /Late device loss/);
});

test("GPU errors arriving during frame writes are rejected after asynchronous I/O", async () => {
  const write = deferred();
  const { session } = harness([assignment("case")], { store: { writeFrame: () => write.promise } });
  session.ready(identity);
  await session.take();
  const pending = session.frame(frame("case"));
  session.log({ level: "error", event: "late_gpu_error", message: "Late GPU error" });
  write.resolve();
  await assert.rejects(pending, /Late GPU error/);
  await session.fail({ caseId: "case", error: "frame failed" });
  assert.equal((await session.done()).status, "failed");
});

test("GPU errors arriving during cache verification cannot be hidden by a cache hit", async () => {
  const lookup = deferred();
  const { session } = harness([assignment("cached")], { store: { cached: () => lookup.promise } });
  session.ready(identity);
  const pending = session.take();
  session.log({ level: "error", scope: "webgpu", message: "GPU error during cache lookup" });
  lookup.resolve(true);
  assert.equal(await pending, null);
  const report = await session.done();
  assert.equal(report.status, "failed");
  assert.equal(report.cases[0].status, "failed");
});

test("GPU errors arriving during case completion can never produce a passing case", async () => {
  const complete = deferred();
  const { session } = harness([assignment("case")], {
    store: { completeCase: () => complete.promise },
  });
  session.ready(identity);
  await session.take();
  await session.frame(frame("case"));
  await session.frame(frame("case", 3));
  const pending = session.completeCase({ caseId: "case", diagnostics });
  session.log({ level: "error", event: "late_gpu_error", message: "Late GPU error" });
  complete.resolve();
  await assert.rejects(pending, /Late GPU error/);
  await session.fail({ caseId: "case", error: "completion failed" });
  const report = await session.done();
  assert.equal(report.status, "failed");
  assert.equal(report.cases[0].status, "failed");
});

for (const operation of ["writeFrame", "completeCase"]) {
  test(`${operation} remains bounded and a late callback cannot accept the following case`, {
    timeout: 1500,
  }, async () => {
    const stalled = deferred();
    const recovered = deferred();
    const { session } = harness([assignment("stalled"), assignment("next")], {
      timeoutMs: 40,
      recover: () => recovered.resolve(),
      store: {
        [operation]: (item) => (item.case.id === "stalled" ? stalled.promise : Promise.resolve()),
      },
    });
    session.ready(identity);
    await session.take();
    let pending;
    if (operation === "writeFrame") pending = session.frame(frame("stalled"));
    else {
      await session.frame(frame("stalled"));
      await session.frame(frame("stalled", 3));
      pending = session.completeCase({ caseId: "stalled", diagnostics });
    }
    const rejected = assert.rejects(pending, /expired/);
    await recovered.promise;
    assert.equal((await session.take()).case.id, "next");
    stalled.resolve();
    await rejected;
    await session.frame(frame("next"));
    await session.frame(frame("next", 3));
    await session.completeCase({ caseId: "next", diagnostics });
    const report = await session.done();
    assert.equal(report.status, "failed");
    assert.deepEqual(
      report.cases.map((item) => [item.id, item.status]),
      [
        ["stalled", "failed"],
        ["next", "passed"],
      ],
    );
  });
}

test("duplicate in-flight writes and completion requests are rejected", async () => {
  const write = deferred();
  const complete = deferred();
  const { session } = harness([assignment("case")], {
    store: {
      writeFrame: () => write.promise,
      completeCase: () => complete.promise,
    },
  });
  session.ready(identity);
  await session.take();
  const pending = session.frame(frame("case"));
  await assert.rejects(session.frame(frame("case")), /duplicate/);
  await assert.rejects(session.completeCase({ caseId: "case", diagnostics }), /missing frames/);
  write.resolve();
  await pending;
  await session.frame(frame("case", 3));
  const completion = session.completeCase({ caseId: "case", diagnostics });
  await assert.rejects(session.completeCase({ caseId: "case", diagnostics }), /already pending/);
  complete.resolve();
  await completion;
  assert.equal((await session.done()).status, "passed");
});

test("recovery failure invokes the fatal shutdown callback", { timeout: 1500 }, async () => {
  const fatal = deferred();
  const { session } = harness([assignment("case")], {
    timeoutMs: 20,
    recover: async () => {
      throw new Error("Recovery failed");
    },
    fatal: (error) => fatal.resolve(error),
  });
  session.ready(identity);
  await session.take();
  const error = await fatal.promise;
  assert.match(error.message, /Recovery failed/);
  await session.abort(error);
});

test("a fatal error after an earlier finish is persisted as failed", async () => {
  const recorded = [];
  const { session } = harness([], {
    store: {
      finish: async (report) => {
        recorded.push(report.status);
      },
    },
  });
  session.ready(identity);
  await session.done();
  await session.fail({ error: "Late fatal process error" });
  assert.deepEqual(recorded, ["passed", "failed"]);
});

test("unavailable owner cases cannot produce a successful or cached run", async () => {
  const { session, calls } = harness(
    [{ case: { id: "owner" }, unavailable: "Owner project missing" }, assignment("cached")],
    { cached: () => true },
  );
  session.ready(identity);
  assert.equal(await session.take(), null);
  const report = await session.done();
  assert.equal(report.status, "failed");
  assert.deepEqual(
    report.cases.map(({ id, status }) => [id, status]),
    [
      ["owner", "skipped"],
      ["cached", "cached"],
    ],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "cached"),
    [["cached", "cached"]],
  );
});

test("failed cases never complete and do not prevent independent captures", async () => {
  const { session, calls } = harness([assignment("bad"), assignment("good")]);
  session.ready(identity);
  await session.take();
  await session.frame(frame("bad"));
  session.log({ level: "warn", scope: "audio", event: "audio_analysis_decode_failed" });
  await assert.rejects(
    session.completeCase({ caseId: "bad", diagnostics }),
    /audio_analysis_decode_failed/,
  );
  await session.fail({ caseId: "bad", error: "Invalid media" });
  await session.take();
  await session.frame(frame("good"));
  await session.frame(frame("good", 3));
  await session.completeCase({ caseId: "good", diagnostics, elapsed_ms: 1 });
  assert.equal(await session.take(), null);
  const report = await session.done();
  assert.equal(report.status, "failed");
  assert.deepEqual(
    report.cases.map((item) => item.status),
    ["failed", "passed"],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "complete"),
    [["complete", "good"]],
  );
});

test("incomplete, mismatched, duplicate, and malformed frames are rejected", async () => {
  const { session } = harness([assignment("case")]);
  session.ready(identity);
  await session.take();
  await assert.rejects(session.completeCase({ caseId: "case", diagnostics }), /missing frames/);
  await assert.rejects(
    session.frame({ ...frame("case"), diagnostics: { description: "other GPU" } }),
    /adapter/,
  );
  await assert.rejects(session.frame(frame("other")), /active case/);
  await assert.rejects(session.frame(frame("case", 9)), /Unexpected/);
  await assert.rejects(session.frame({ ...frame("case"), pixels: new ArrayBuffer(4) }), /RGBA8/);
  await session.frame(frame("case"));
  await assert.rejects(session.frame(frame("case")), /duplicate/);
  await session.abort(new Error("test complete"));
});

test("case timeout marks failure and requests a fresh renderer", async () => {
  let recovered;
  const recovery = new Promise((resolve) => {
    recovered = resolve;
  });
  const { session } = harness([assignment("timeout")], { timeoutMs: 15, recover: recovered });
  session.ready(identity);
  await session.take();
  await recovery;
  const report = await session.done();
  assert.equal(report.status, "failed");
  assert.match(report.cases[0].error, /timed out/);
});

test("fatal diagnostics fail closed while ordinary warning telemetry does not", () => {
  assert.equal(captureLogIsFailure({ level: "error", event: "unknown" }), true);
  assert.equal(captureLogIsFailure({ level: "warn", scope: "webgpu", event: "device_lost" }), true);
  assert.equal(
    captureLogIsFailure({ level: "warn", scope: "image", event: "decode_failed" }),
    true,
  );
  assert.equal(captureLogIsFailure({ level: "warn", event: "cache_budget" }), false);
});

test("host cache identity ignores transient GPU memory while tracking drivers", () => {
  const gpu = { gpuDevice: [{ vendorId: 1, deviceId: 2, driverVersion: "one" }], memory: 100 };
  const first = captureHostInfo(gpu, {});
  const second = captureHostInfo({ ...gpu, memory: 999 }, {});
  assert.deepEqual(first.cacheIdentity, second.cacheIdentity);
  assert.notDeepEqual(
    first.cacheIdentity,
    captureHostInfo({ gpuDevice: [{ ...gpu.gpuDevice[0], driverVersion: "two" }] }, {})
      .cacheIdentity,
  );
  assert.equal(first.native_backend, null);
});

test("plan samples require prepared receipts and cannot become pixel frames", async () => {
  const item = assignment("plan-case");
  item.frames = [0];
  item.planSamples = { samples: [{ index: 0, time: 0.001 }] };
  const { session, calls } = harness([item], {
    planReferences: true,
    store: {
      prepareFrame: async () => ({ receipt: {} }),
      writePlan: async (_item, payload) => calls.push(["plan", payload.frame, payload.time]),
    },
  });
  session.ready(identity);
  await session.take();
  const payload = { caseId: item.case.id, frame: 0, time: 0.001, diagnostics };
  await assert.rejects(session.plan(payload), /Unexpected/);
  await assert.rejects(session.frame(frame(item.case.id)), /cannot accept pixel/);
  await session.prepareFrame(payload);
  await session.plan(payload);
  await assert.rejects(session.plan(payload), /duplicate/);
  await session.completeCase({ caseId: item.case.id, diagnostics });
  assert.equal((await session.done()).status, "passed");
  assert(calls.some((call) => call[0] === "plan" && call[2] === 0.001));
  assert(!calls.some((call) => call[0] === "frame"));
});
