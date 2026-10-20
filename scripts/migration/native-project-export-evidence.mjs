import assert from "node:assert/strict";
import { dirname, join, relative, resolve } from "node:path";
import { createServer } from "vite";
import { M0Evidence, sha256, validSha } from "./m0-evidence.mjs";

/** Authenticate original export receipts, addresses and resources, independent of pixel verdicts. */
export async function auditProjectExportEvidence(root, execution, job) {
  assert.equal(execution.kind, "native-project-export");
  const reader = new M0Evidence(root);
  const local = (path) => relative(root, resolve(root, path)).replaceAll("\\", "/");
  const saved = await reader.json(execution.arms.rust.path, execution.arms.rust.sha256);
  assert.deepEqual(saved, execution.arms.rust.raw);
  const entry = saved.cases.find((value) => value.caseId === job.case.id);
  assert(entry);
  const receipt = entry.receipt;
  const command = entry.step.command;
  assert.equal(resolve(command[0]), resolve(root, execution.native_binary));
  assert.equal(command[1], "export");
  const option = (name) => {
    assert.equal(
      command.filter((value) => value === name).length,
      1,
      `Missing or duplicated ${name}`,
    );
    return command[command.indexOf(name) + 1];
  };
  assert.equal(resolve(option("--project")), resolve(job.projectPath));
  assert.equal(option("--composition"), job.case.composition);
  assert.equal(
    Number(option("--frames")),
    job.benchmark.endFrameExclusive - job.benchmark.startFrame,
  );
  assert.equal(Number(option("--start-frame")), job.benchmark.startFrame);
  assert.equal(Number(option("--width")), job.case.size.width);
  assert.equal(Number(option("--height")), job.case.size.height);
  assert.equal(Number(option("--bitrate")), 20000000);
  for (const forbidden of ["--plan", "--batch", "--resources"])
    assert(!command.includes(forbidden));
  assert.equal(entry.step.status, "passed");
  assert.equal(entry.step.exit_code, 0);
  const log = (await reader.bytes(entry.step.log)).bytes.toString("utf8");
  assert.equal(log.split(/\r?\n/)[0], `Command: ${JSON.stringify(command)}`);
  assert.deepEqual(
    JSON.parse(
      log
        .split(/\r?\n/)
        .filter((line) => line.startsWith("{"))
        .at(-1),
    ),
    receipt,
  );
  const request = await reader.json(local(option("--request")));
  assert.deepEqual(Object.keys(request).sort(), ["plugins", "rasterProvider", "settings"]);
  assert.deepEqual(
    request.plugins,
    (job.case.plugins ?? []).map((path) => join(root, path, "plugin.toml")),
  );
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.project.authored_sha256, job.inputs.project_sha256);
  const binding = { path: local(receipt.witness.path), sha256: receipt.witness.report_sha256 };
  const witness = await reader.json(binding.path, binding.sha256);
  assert.deepEqual(witness, entry.witness);
  assert.equal(witness.status, "captured");
  assert.equal(witness.project_authored_sha256, receipt.project.authored_sha256);
  assert.equal(witness.project_runtime_sha256, receipt.project.runtime_sha256);
  assert.deepEqual(witness.video, receipt.video);
  assert.deepEqual(witness.adapter, receipt.adapter);
  assert.equal(witness.frame_count, job.benchmark.endFrameExclusive - job.benchmark.startFrame);
  assert.equal(receipt.report.frames, witness.frame_count);
  assert.equal(receipt.report.encoder.drain_completed, true);
  assert.equal(receipt.report.encoder.encoded_frames, witness.frame_count);
  assert.equal(receipt.report.encoder.accepted_frames, witness.frame_count);
  assert.equal(receipt.report.encoder.cancelled, false);
  assert(["nv12-readback", "nv12-shared"].includes(witness.transport));
  assert.equal(witness.transport, receipt.report.transport);
  assert(["Dx12", "Vulkan", "Metal"].includes(receipt.adapter.backend));
  assert.notEqual(receipt.adapter.device_type, "Cpu");
  assert.deepEqual(receipt.video.size, job.case.size);
  assert.deepEqual(receipt.video.frame_rate, {
    numerator: job.benchmark.frameRate.numerator,
    denominator: job.benchmark.frameRate.denominator,
  });
  assert.equal(receipt.video.bitrate_bps, 20000000);
  assert.equal(resolve(witness.output), resolve(entry.output.outputPath));
  await reader.bytes(local(witness.output), witness.output_sha256);
  assert.equal(witness.output_sha256, entry.output.ffprobe.sha256);
  assert.deepEqual(
    witness.frames.map((frame) => frame.index),
    job.case.frames.toSorted((a, b) => a - b).map((frame) => frame - job.benchmark.startFrame),
  );
  const runtime = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { decodeFramePlan } = await runtime.ssrLoadModule("/src/renderer/frame-plan/codec.ts");
    const { contentResourceHashSync } = await runtime.ssrLoadModule(
      "/src/renderer/frame-plan/resources.ts",
    );
    const base = dirname(receipt.witness.path),
      resources = new Map();
    for (const frame of witness.frames) {
      assert.equal(frame.rgb.index, frame.index);
      assert.equal(frame.composition, job.case.composition);
      const time =
        ((job.benchmark.startFrame + frame.index) * job.benchmark.frameRate.denominator) /
        job.benchmark.frameRate.numerator;
      assert.equal(frame.time, time);
      const bits = Buffer.alloc(8);
      bits.writeDoubleBE(time);
      assert.equal(frame.time_bits, bits.toString("hex"));
      assert.equal(frame.snapshot_scope, `native-project:${receipt.project.authored_sha256}`);
      assert.equal(frame.project_revision, 0);
      const directory = join(base, String(frame.index));
      const image = await reader.image(
        local(join(directory, "candidate.png")),
        frame.rgb.png_sha256,
      );
      assert.equal(image.rgba_sha256, frame.rgb.rgba_sha256);
      assert.equal(image.width, job.case.size.width);
      assert.equal(image.height, job.case.size.height);
      const plan = decodeFramePlan(
        (await reader.bytes(local(join(directory, "plan.fpln")), frame.rgb.plan_sha256)).bytes,
      );
      assert.equal(plan.metadata.header.snapshot_scope, frame.snapshot_scope);
      assert.equal(plan.metadata.header.project_revision, frame.project_revision);
      const messages = await reader.json(local(join(directory, "resources.json")));
      assert.equal(messages.length, frame.rgb.resource_count);
      assert.equal(new Set(messages.map((message) => message.hash)).size, messages.length);
      for (const message of messages) {
        assert.equal(message.type, "put_resource");
        validSha(message.hash);
        const identity = sha256(JSON.stringify(message));
        if (resources.has(message.hash)) {
          assert.equal(resources.get(message.hash), identity);
          continue;
        }
        const packet = await reader.bytes(local(join(base, "resources", `${message.hash}.bin`)));
        assert.equal(
          contentResourceHashSync(
            { kind: message.kind, descriptor: message.descriptor },
            packet.bytes,
          ),
          message.hash,
        );
        resources.set(message.hash, identity);
      }
      const members = new Set(messages.map((message) => message.hash));
      for (const hash of plan.metadata.resources) assert(members.has(hash));
      const nv12 = await reader.bytes(local(join(directory, "input.nv12")), frame.nv12_sha256);
      assert.equal(nv12.bytes.length, frame.nv12_bytes);
      assert.equal(frame.nv12_bytes, (image.width * image.height * 3) / 2);
      assert.equal(
        frame.nv12_binding,
        witness.transport === "nv12-readback"
          ? "exact-encoder-memory-input"
          : "same-frame-shared-conversion-mirror",
      );
    }
  } finally {
    await runtime.close();
  }
  return { witness, binding, checked_files: await reader.stable() };
}
