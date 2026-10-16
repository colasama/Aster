import assert from "node:assert/strict";
import { posix } from "node:path";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { initializationCrashedBeforeBegin } from "./native-initialization-failure.mjs";

/** Decode the saved control/binary stream instead of trusting its embedded response summary. */
export function exportStreamResponses(bytes) {
  const responses = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    assert(end >= offset && end - offset <= 1048576, "Invalid saved control line");
    const reply = JSON.parse(bytes.subarray(offset, end).toString("utf8"));
    assert.equal(reply.version, 1);
    assert.equal(reply.request_id, responses.length + 1);
    assert(Number.isSafeInteger(reply.payload_bytes) && reply.payload_bytes >= 0);
    offset = end + 1 + reply.payload_bytes;
    assert(offset <= bytes.length, "Truncated saved export payload");
    responses.push(reply.response);
  }
  return responses;
}

/** Authenticate both attempts before accepting a recovered automatic stream control. */
export async function auditInitializationRecovery(reader, check, startedAt) {
  const { record, prefix_length, ...failure } = check.initialization_failure;
  assert.deepEqual(await reader.json(record.path, record.sha256), failure);
  const failedBytes = await reader.bytes(failure.output, failure.output_sha256);
  assert(initializationCrashedBeforeBegin(failure, failedBytes.bytes, prefix_length));
  assert.equal(failure.command[2], "--native-export");
  assert.equal(check.command[2], "--native-readback-export");
  assert.equal(failure.command[1], "serve");
  assert.equal(check.command[1], "serve");
  assert.deepEqual(failure.command.slice(3), check.command.slice(3));
  assert.equal(failure.command[0], check.command[0]);
  assert.equal(failure.input_sha256, check.input_sha256);
  assert(Date.parse(failure.started_at) >= Date.parse(startedAt));
  assert(Date.parse(failure.finished_at) >= Date.parse(failure.started_at));
  assert(Date.parse(check.finished_at) >= Date.parse(failure.finished_at));
  assert.equal(check.responses[prefix_length].type, "export_started");
  assert.equal(check.responses[prefix_length].transport, "nv12-readback");
  for (const reply of check.responses) {
    if (reply.type !== "capabilities" && reply.encoder) {
      assert.equal(reply.encoder.gpu_input_frames, 0);
      assert.equal(reply.encoder.retired_gpu_frames, 0);
    }
  }
}

export async function auditM8Sessions(reader, native, report) {
  const output = posix.dirname(native.build.log);
  const names = [
    "native_session",
    "native_export_stream",
    "native_shared_export_stream",
    "native_electron_session",
    "native_preflight_media",
    "native_job",
    "native_untagged_video",
  ];
  for (const name of names) {
    const group = native[name];
    assert.equal(group?.status, "passed", `Missing native session evidence: ${name}`);
    assert.deepEqual(
      await reader.json(`${output}/${name.replaceAll("_", "-")}/report.json`),
      group,
    );
    if (group.binary) assert.deepEqual(group.binary, native.binary);
    if (group.compile) validateCurrentStep(group.compile, report.started_at);
    for (const file of group.modules ?? []) await reader.bytes(file.path, file.sha256);
  }
  for (const name of [
    "nv12_conversion_smoke",
    "nv12_sharing_smoke",
    "native_plan_capture",
    "native_job_capture",
    "native_untagged_video_step",
  ])
    validateCurrentStep(native[name], report.started_at);
  const sessionNames = [
    "resource-lifecycle",
    "hash-rejection",
    "budget-rejection",
    "truncated-binary",
    "oversized-binary",
    "oversized-control",
    "unknown-command-field",
    "duplicate-id",
    "hardware-probe",
    "matching-adapter",
    "wrong-adapter",
    "normal-resource-retirement",
  ];
  assert.deepEqual(
    native.native_session.checks.map((c) => c.name),
    sessionNames,
  );
  for (const [index, step] of native.native_session.checks.entries()) {
    assert.equal(step.exit_code, index >= 3 && index <= 7 ? 2 : 0);
    assert(Date.parse(step.started_at) >= Date.parse(report.started_at));
    assert(Date.parse(step.finished_at) >= Date.parse(step.started_at));
  }
  const streamNames = [
    "complete",
    "cancel",
    "cancel-restart",
    "early-finish",
    "wrong-order",
    "late-warmup",
    "missing-resource",
    "packet-budget",
    "gpu-budget",
  ];
  for (const [name, shared] of [
    ["native_export_stream", false],
    ["native_shared_export_stream", true],
  ]) {
    const stream = native[name];
    assert.equal(stream.transport, shared ? "auto" : "readback");
    assert.deepEqual(
      stream.checks.map((c) => c.name),
      [...streamNames, ...(shared ? ["readback-fallback"] : [])],
    );
    for (const check of stream.checks) {
      validateCurrentStep({ ...check, status: "passed" }, report.started_at);
      const bytes = await reader.bytes(check.output, check.output_sha256);
      assert.deepEqual(exportStreamResponses(bytes.bytes), check.responses);
      if (check.initialization_failure) {
        assert(shared && streamNames.includes(check.name));
        await auditInitializationRecovery(reader, check, report.started_at);
      }
    }
    const complete = stream.checks[0].responses;
    const begun = complete.find((r) => r.type === "export_started");
    const final = complete.find((r) => r.type === "encoded" && r.complete);
    assert.equal(stream.selected_transport, begun.transport);
    assert(["nv12-shared", "nv12-readback"].includes(begun.transport));
    if (!shared) assert.equal(begun.transport, "nv12-readback");
    if (shared && begun.transport === "nv12-readback")
      assert(stream.checks[0].initialization_failure || begun.transport_reason);
    assert.equal(final.encoder.accepted_frames, 60);
    assert.equal(final.encoder.encoded_frames, 60);
    assert.equal(final.encoder.drain_completed, true);
    assert.equal(final.encoder.gpu_input_frames, begun.transport === "nv12-shared" ? 60 : 0);
    assert.equal(final.encoder.retired_gpu_frames, begun.transport === "nv12-shared" ? 60 : 0);
    for (const file of [stream.decoded_output, stream.output])
      await reader.bytes(file.path, file.sha256);
    for (const step of [stream.mux, stream.probe, stream.decode])
      validateCurrentStep(step, report.started_at);
  }
  const electron = native.native_electron_session;
  assert.deepEqual(
    electron.checks.map((c) => c.name),
    [
      "native-audio-atomic-mux",
      "cancel-preserves-existing-output",
      "missing-frames-preserves-existing-output",
      "cancel-finish-preserves-existing-output",
    ],
  );
  assert(electron.checks.every((c) => c.status === "passed"));
  assert.deepEqual(
    electron.initializations.map((c) => c.phase),
    ["audiovisual", "cancel", "missing-frames", "cancel-finish"],
  );
  for (const initialization of electron.initializations) {
    assert([1, 2].includes(initialization.attempts));
    assert(["nv12-shared", "nv12-readback"].includes(initialization.transport));
    if (initialization.attempts === 2) {
      assert.equal(initialization.transport, "nv12-readback");
      assert(initialization.reason?.length > 0);
    }
  }
  assert.equal(electron.output.encoder, "h264_mf");
  assert.equal(electron.output.frameCount, 60);
  assert.equal(electron.output.audioFrameCount, 96096);
  assert.equal(electron.video_sha256, native.native_export_stream.decoded_output.sha256);
  assert.equal(electron.video_sha256, native.native_shared_export_stream.decoded_output.sha256);
  await reader.bytes(`${output}/native-electron-session/decoded.rgba`, electron.video_sha256);
  for (const name of ["native-plan-capture", "native-job-capture"]) {
    const capture = await reader.json(`${output}/${name}/report.json`);
    assert.equal(capture.status, "passed");
    assert.equal(capture.source.source_sha256, report.source.source_sha256);
    assert.equal(capture.frames.length, 6);
    assert(
      capture.frames.every(
        (f) =>
          f.plan_only_exact &&
          f.plan_only_final_output_accesses === 0 &&
          f.plan_only_file_pixel_captures === 0,
      ),
    );
    for (const frame of capture.frames) {
      await reader.bytes(frame.plan.path, frame.plan.sha256);
      for (const file of frame.resources)
        await reader.bytes(`${output}/${name}/resources/${file.message.hash}.bin`, file.sha256);
    }
  }
  assert.equal(native.native_job.jobs.length, 2);
  assert.equal(native.native_job.warmup.frames, 10);
  assert.deepEqual(
    native.native_job.rejections.map((c) => c.scenario),
    [
      "foreign-warmup",
      "late-warmup",
      "foreign-job",
      "late-foreign-frame",
      "missing-frame",
      "cancel-export",
      "cancel-prepare",
      "unsupported-output",
    ],
  );
  assert(native.native_job.rejections.every((c) => c.status === "passed"));
  assert.deepEqual(
    native.native_preflight_media.rejections.map((c) => c.name),
    ["ungranted-media", "supplied-file-pixels"],
  );
  assert(native.native_preflight_media.rejections.every((c) => c.status === "passed"));
  const media = native.native_preflight_media;
  await reader.bytes(media.preflight_module.path, media.preflight_module.sha256);
  const initialization = media.initialization;
  assert.equal(initialization.before_admission, true);
  assert([1, 2].includes(initialization.attempts));
  assert(["nv12-shared", "nv12-readback"].includes(initialization.transport));
  assert.deepEqual(initialization.adapter_luid, initialization.probed_adapter_luid);
  assert.equal(media.export.transport, initialization.transport);
  assert.equal(media.export.frameCount, 6);
  assert.equal(media.frames.length, 6);
  if (initialization.attempts === 2) {
    assert.equal(initialization.transport, "nv12-readback");
    assert(initialization.reason?.length > 0);
  }
  return { status: "passed", groups: names };
}
