import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

const packet = (request_id, command, payload = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from(`${JSON.stringify({ version: 1, request_id, command })}\n`), payload]);
const put = (message, bytes) => {
  const { type, ...resource } = message;
  assert.equal(type, "put_resource");
  return { type, resource, payload_bytes: bytes.length };
};

/** Exercise the actual long-lived worker; frame admission is not export acceptance. */
export async function runNativeSessionGate(context, { binary, compiler }) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const started = Date.now();
  const report = { status: "failed", started_at: new Date().toISOString(), checks: [] };
  await mkdir(context.output, { recursive: true });
  try {
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pin = ledger.milestones.find((m) => m.id === "M3").input_manifest;
    const manifest = await reader.json(pin.path, pin.sha256);
    const base = posix.dirname(pin.path);
    const fixture = manifest.frames.find((f) => f.case_id === "shape-rectangle" && f.frame === 0);
    assert(fixture);
    const meta = await reader.json(`${base}/${fixture.meta_path}`, fixture.meta_sha256);
    const files = meta.frame_plan.files;
    const frameRoot = `${base}/shape-rectangle/0`;
    const resources = await reader.json(`${frameRoot}/resources.json`, files["resources.json"]);
    const plan = (await reader.bytes(`${frameRoot}/replay.fpln`, files["replay.fpln"])).bytes;
    const resourceBytes = [];
    for (const resource of resources) {
      const bytes = (
        await reader.bytes(`${base}/shape-rectangle/frame-resources/${resource.hash}.bin`)
      ).bytes;
      validateFrameResource(resource, bytes);
      resourceBytes.push(bytes);
    }
    const run = async (name, input, extra = [], expectedExit = 0) => {
      const args = [
        "serve",
        "--texture-ffmpeg",
        join(context.root, "build/ffmpeg/ffmpeg.exe"),
        ...extra,
      ];
      const step = {
        name,
        command: [binary, ...args],
        started_at: new Date().toISOString(),
        input_sha256: sha256(input),
      };
      const result = await new Promise((done) => {
        const child = execFile(
          binary,
          args,
          {
            cwd: context.root,
            env: context.env,
            windowsHide: true,
            timeout: 60_000,
            maxBuffer: 2 * 1024 * 1024,
            encoding: "buffer",
          },
          (error, stdout, stderr) => done({ error, stdout, stderr }),
        );
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
      });
      step.finished_at = new Date().toISOString();
      step.exit_code = result.error?.code ?? 0;
      step.signal = result.error?.signal ?? null;
      step.stdout = result.stdout.toString("utf8");
      step.stderr = result.stderr.toString("utf8");
      report.checks.push(step);
      await writeAtomicJson(join(context.output, `${name}.json`), step);
      assert.equal(step.exit_code, expectedExit, `${name}: ${result.error?.message}`);
      assert.equal(step.signal, null);
      const replies = step.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      assert(replies.every((r) => r.version === 1 && r.payload_bytes === 0));
      return replies;
    };
    const commands = resources.map((r, i) =>
      packet(i + 1, put(r, resourceBytes[i]), resourceBytes[i]),
    );
    const command = put(resources[0], resourceBytes[0]);
    let id = commands.length;
    commands.push(packet(++id, command, resourceBytes[0]));
    const duplicate = id;
    commands.push(packet(++id, { type: "check_frame", plan_bytes: plan.length }, plan));
    const check = id;
    commands.push(packet(++id, { type: "evict_resource", hash: resources[0].hash }));
    commands.push(packet(++id, { type: "check_frame", plan_bytes: plan.length }, plan));
    const missing = id;
    commands.push(packet(++id, command, resourceBytes[0]));
    commands.push(packet(++id, { type: "check_frame", plan_bytes: plan.length }, plan));
    const restored = id;
    commands.push(packet(++id, { type: "shutdown" }));
    const replies = await run("resource-lifecycle", Buffer.concat(commands));
    assert.deepEqual(
      replies.map((r) => r.request_id),
      Array.from({ length: id }, (_, i) => i + 1),
    );
    assert.equal(replies[duplicate - 1].response.inserted, false);
    assert.equal(replies[check - 1].response.plan_sha256, sha256(plan));
    assert.equal(replies[missing - 1].response.type, "error");
    assert.deepEqual(replies[restored - 1].response, replies[check - 1].response);
    const bad = Buffer.from(resourceBytes[0]);
    bad[bad.length - 1] ^= 1;
    const hash = await run(
      "hash-rejection",
      Buffer.concat([
        packet(1, command, bad),
        packet(2, command, resourceBytes[0]),
        packet(3, { type: "shutdown" }),
      ]),
    );
    assert.equal(hash[0].response.type, "error");
    assert.equal(hash[1].response.inserted, true);
    const budget = await run(
      "budget-rejection",
      Buffer.concat([packet(1, command, resourceBytes[0]), packet(2, { type: "shutdown" })]),
      ["--resource-byte-budget", "16"],
    );
    assert.equal(budget[0].response.type, "error");
    for (const [name, wire, args] of [
      [
        "truncated-binary",
        packet(1, { type: "check_frame", plan_bytes: plan.length }, plan.subarray(0, -1)),
        [],
      ],
      [
        "oversized-binary",
        packet(1, { type: "check_frame", plan_bytes: 100 }),
        ["--max-payload-bytes", "64"],
      ],
      ["oversized-control", Buffer.alloc(257, "x"), ["--max-control-bytes", "256"]],
      ["unknown-command-field", packet(1, { type: "shutdown", unexpected: true }), []],
      [
        "duplicate-id",
        Buffer.concat([
          packet(1, { type: "evict_resource", hash: "0".repeat(64) }),
          packet(1, { type: "shutdown" }),
        ]),
        [],
      ],
    ]) {
      const responses = await run(name, wire, args, 2);
      assert.equal(responses.at(-1).response.terminal, true);
    }
    const video = {
      size: { width: 128, height: 128 },
      frame_rate: { numerator: 30, denominator: 1 },
      bitrate_bps: 2_000_000,
    };
    const probe = await run(
      "hardware-probe",
      Buffer.concat([
        packet(1, { type: "probe", adapter_luid: null, video }),
        packet(2, { type: "shutdown" }),
      ]),
      compiler ? ["--dxcompiler", compiler] : [],
    );
    const capability = probe[0].response;
    assert.equal(capability.type, "capabilities");
    assert.equal(capability.export_available, false);
    assert.equal(capability.encoder.hardware_only, true);
    assert(capability.encoder.candidates.some((c) => c.configuration_accepted));
    assert.deepEqual(capability.adapter_luid, capability.encoder.adapter_luid);
    assert.equal(capability.encoder.test_frame_verified, true);
    const proof = capability.encoder.candidates.find((c) => c.encoded_proof)?.encoded_proof;
    assert(proof);
    assert.equal(proof.frames, 3);
    assert.equal(proof.packets, 3);
    assert(
      proof.encoded_bytes > 0 && proof.ordered_timestamps && proof.annex_b && proof.drain_completed,
    );
    const matched = await run(
      "matching-adapter",
      Buffer.concat([
        packet(1, { type: "probe", adapter_luid: capability.adapter_luid, video }),
        packet(2, { type: "shutdown" }),
      ]),
    );
    assert.deepEqual(matched[0].response.adapter_luid, capability.adapter_luid);
    const wrong = await run(
      "wrong-adapter",
      Buffer.concat([
        packet(1, { type: "probe", adapter_luid: { low: 0, high: 0 }, video }),
        packet(2, { type: "shutdown" }),
      ]),
    );
    assert.equal(wrong[0].response.type, "error");
    const normalPin = ledger.reference_baseline.native_normal;
    const frame = (await reader.json(normalPin.path, normalPin.sha256)).frames[0];
    const normalPlan = (await reader.bytes(frame.plan.path, frame.plan.sha256)).bytes;
    const rank = (r) =>
      ({ media_source: 0, media_frame: 1, raster_pixels: 2 })[r.message.kind] ?? 3;
    const normalCommands = [];
    for (const r of [...frame.resources].sort((a, b) => rank(a) - rank(b))) {
      const bytes = (await reader.bytes(r.path, r.sha256)).bytes;
      validateFrameResource(r.message, bytes);
      normalCommands.push(packet(normalCommands.length + 1, put(r.message, bytes), bytes));
    }
    const before = normalCommands.length;
    for (let i = 0; i < 2; i++)
      normalCommands.push(
        packet(
          normalCommands.length + 1,
          { type: "check_frame", plan_bytes: normalPlan.length },
          normalPlan,
        ),
      );
    normalCommands.push(packet(normalCommands.length + 1, { type: "shutdown" }));
    const normals = await run("normal-resource-retirement", Buffer.concat(normalCommands));
    assert.equal(normals[before].response.type, "frame_checked");
    assert.equal(normals[before + 1].response.type, "frame_checked");
    assert.deepEqual(normals[before - 1].response.usage, normals[before].response.usage);
    assert.deepEqual(normals[before].response.usage, normals[before + 1].response.usage);
    report.checked_files = await reader.stable();
    assert.equal(await hashFile(binary), report.binary.sha256);
    report.scope =
      "Bounded session transport, supplied-frame admission and ordered hardware test frames; no complete export acceptance";
    report.native_export_acceptance = false;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { out: { type: "string" }, binary: { type: "string" } },
  });
  assert(values.out && values.binary, "--out and --binary are required");
  const root = process.cwd();
  const report = await runNativeSessionGate(
    { root, output: resolve(values.out), env: process.env },
    {
      binary: resolve(values.binary),
      compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
    },
  );
  console.log(`${report.status}: ${report.checks.length} native session checks`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
