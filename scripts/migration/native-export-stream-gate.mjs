import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { initializationCrashedBeforeBegin } from "./native-initialization-failure.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

const control = (command, payload = Buffer.alloc(0)) => ({ command, payload });

/** Complete supplied-frame transport smoke; application/audio/quality gates remain separate. */
export async function runNativeExportStreamGate(
  context,
  { binary, compiler, transport = "readback" },
  execute = runStep,
) {
  assert(["readback", "shared", "auto"].includes(transport), "Unknown native input transport");
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const started = Date.now();
  const report = {
    status: "failed",
    checks: [],
    scope: "Native GPU-to-hardware H264 stream lifecycle",
    native_export_acceptance: false,
    transport,
  };
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
    const video = {
      size: meta.size,
      frame_rate: { numerator: 30000, denominator: 1001 },
      bitrate_bps: 8_000_000,
    };
    const prefix = [control({ type: "probe", adapter_luid: null, video })];
    for (const resource of resources) {
      const bytes = (
        await reader.bytes(`${base}/shape-rectangle/frame-resources/${resource.hash}.bin`)
      ).bytes;
      validateFrameResource(resource, bytes);
      const { type, ...message } = resource;
      assert.equal(type, "put_resource");
      prefix.push(control({ type, resource: message, payload_bytes: bytes.length }, bytes));
    }
    const frame = (index) =>
      control({ type: "render_frame", frame_index: index, plan_bytes: plan.length }, plan);
    const begin = (count) => control({ type: "begin_export", video, frame_count: count });
    const run = async (name, controls, extra = [], allowInitializationFallback = false) => {
      const requests = [...prefix, ...controls, control({ type: "shutdown" })];
      const wire = Buffer.concat(
        requests.flatMap(({ command, payload }, index) => [
          Buffer.from(`${JSON.stringify({ version: 1, request_id: index + 1, command })}\n`),
          payload,
        ]),
      );
      const args = [
        "serve",
        transport === "auto" ? "--native-export" : `--native-${transport}-export`,
        ...(compiler ? ["--dxcompiler", compiler] : []),
        ...extra,
      ];
      const step = {
        name,
        command: [binary, ...args],
        input_sha256: sha256(wire),
        started_at: new Date().toISOString(),
      };
      const invoke = () =>
        new Promise((done) => {
          const child = execFile(
            binary,
            args,
            {
              cwd: context.root,
              env: context.env,
              windowsHide: true,
              timeout: 120_000,
              maxBuffer: 67_108_864,
              encoding: "buffer",
            },
            (error, stdout, stderr) => done({ error, stdout, stderr }),
          );
          child.stdin.on("error", () => undefined);
          child.stdin.end(wire);
        });
      let result = await invoke();
      const initial = {
        ...step,
        finished_at: new Date().toISOString(),
        exit_code: result.error?.code ?? 0,
        signal: result.error?.signal ?? null,
        output_sha256: sha256(result.stdout),
        stderr: result.stderr.toString("utf8"),
        output: local(join(context.output, `${name}.initialization.bin`)),
      };
      if (
        transport === "auto" &&
        allowInitializationFallback &&
        initializationCrashedBeforeBegin(initial, result.stdout, prefix.length)
      ) {
        // Match the application's single fresh-process readback qualification. No export
        // response may precede recovery, so partially executed jobs can never be replayed.
        await writeFile(join(context.output, `${name}.initialization.bin`), result.stdout, {
          flag: "wx",
        });
        const record = join(context.output, `${name}.initialization.json`);
        await writeAtomicJson(record, initial);
        step.initialization_failure = {
          ...initial,
          prefix_length: prefix.length,
          record: { path: local(record), sha256: await hashFile(record) },
        };
        args[1] = "--native-readback-export";
        step.command = [binary, ...args];
        result = await invoke();
      }
      step.finished_at = new Date().toISOString();
      step.exit_code = result.error?.code ?? 0;
      step.signal = result.error?.signal ?? null;
      step.output_sha256 = sha256(result.stdout);
      step.stderr = result.stderr.toString("utf8");
      step.output = local(join(context.output, `${name}.bin`));
      await writeFile(join(context.output, `${name}.bin`), result.stdout, { flag: "wx" });
      report.checks.push(step);
      await writeAtomicJson(join(context.output, `${name}.json`), step);
      assert.equal(step.exit_code, 0, `${name}: ${result.error?.message}`);
      assert.equal(step.signal, null);
      let remaining = result.stdout;
      const replies = [];
      const packets = [];
      const chunks = [];
      while (remaining.length) {
        const newline = remaining.indexOf(10);
        assert(newline >= 0 && newline < 65_536);
        const reply = JSON.parse(remaining.subarray(0, newline).toString("utf8"));
        assert.equal(reply.version, 1);
        assert.equal(reply.request_id, replies.length + 1);
        assert(
          Number.isSafeInteger(reply.payload_bytes) &&
            reply.payload_bytes >= 0 &&
            reply.payload_bytes <= 67_108_864,
        );
        remaining = remaining.subarray(newline + 1);
        assert(remaining.length >= reply.payload_bytes);
        const payload = remaining.subarray(0, reply.payload_bytes);
        remaining = remaining.subarray(reply.payload_bytes);
        if (reply.response.type === "encoded") {
          assert.equal(
            reply.response.packets.reduce((sum, p) => sum + p.payload_bytes, 0),
            payload.length,
          );
          packets.push(...reply.response.packets);
          chunks.push(payload);
        } else assert.equal(payload.length, 0);
        replies.push(reply.response);
      }
      assert.equal(replies.length, requests.length);
      if (step.initialization_failure) {
        assert.equal(replies[prefix.length].type, "export_started");
        assert.equal(replies[prefix.length].transport, "nv12-readback");
        assert(
          replies.every(
            (r) => r.type === "capabilities" || !r.encoder || r.encoder.gpu_input_frames === 0,
          ),
        );
      }
      step.responses = replies;
      await writeAtomicJson(join(context.output, `${name}.json`), step);
      return {
        replies: replies.slice(prefix.length, -1),
        packets,
        annex: Buffer.concat(chunks),
        initializationFailure: step.initialization_failure,
      };
    };
    const complete = await run(
      "complete",
      [
        begin(60),
        ...Array.from({ length: 10 }, () =>
          control({ type: "warm_frame", plan_bytes: plan.length }, plan),
        ),
        ...Array.from({ length: 60 }, (_, i) => frame(i)),
        control({ type: "finish_export" }),
      ],
      [],
      true,
    );
    assert(complete.replies.every((reply) => reply.type !== "error"));
    for (const [index, reply] of complete.replies.slice(1, 11).entries()) {
      assert.equal(reply.type, "frame_warmed");
      assert.equal(reply.warmup_frames, index + 1);
      assert.equal(reply.frame.plan_sha256, sha256(plan));
      assert.deepEqual(reply.encoder, complete.replies[0].encoder);
    }
    assert.equal(complete.packets.length, 60);
    complete.packets.forEach((packet, index) => {
      assert.equal(packet.frame_index, index);
      assert.equal(packet.timestamp_100ns, Math.floor((index * 10_000_000 * 1001) / 30000));
      assert.equal(
        packet.duration_100ns,
        Math.floor(((index + 1) * 10_000_000 * 1001) / 30000) - packet.timestamp_100ns,
      );
    });
    const final = complete.replies.at(-1);
    assert.equal(final.complete, true);
    assert.equal(final.encoder.accepted_frames, 60);
    assert.equal(final.encoder.encoded_frames, 60);
    assert.equal(final.encoder.encoded_bytes, complete.annex.length);
    assert(final.encoder.peak_inflight_frames <= 4 && final.encoder.drain_completed);
    report.selected_transport = complete.replies[0].transport;
    assert(["nv12-shared", "nv12-readback"].includes(report.selected_transport));
    if (transport !== "auto")
      assert.equal(
        report.selected_transport,
        transport === "readback" ? "nv12-readback" : "nv12-shared",
      );
    if (transport === "auto" && report.selected_transport === "nv12-readback")
      assert(complete.initializationFailure || complete.replies[0].transport_reason);
    else assert.equal(complete.replies[0].transport_reason, null);
    const gpuFrames = report.selected_transport === "nv12-shared" ? 60 : 0;
    assert.equal(final.encoder.gpu_input_frames, gpuFrames);
    assert.equal(final.encoder.retired_gpu_frames, gpuFrames);
    assert(final.encoder.peak_gpu_leases <= 4);
    const annexPath = join(context.output, "output.h264");
    const mp4Path = join(context.output, "output.mp4");
    await writeFile(annexPath, complete.annex, { flag: "wx" });
    report.mux = await execute(
      {
        id: "native-stream-mux",
        file: join(context.root, "build/ffmpeg/ffmpeg.exe"),
        args: [
          "-v",
          "error",
          "-r",
          "30000/1001",
          "-f",
          "h264",
          "-i",
          annexPath,
          "-c:v",
          "copy",
          "-bsf:v",
          "setts=ts=N*1001:duration=1001:time_base=1/30000,h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
          "-movflags",
          "+faststart",
          "-n",
          mp4Path,
        ],
      },
      context,
    );
    assert.equal(report.mux.status, "passed");
    report.probe = await execute(
      {
        id: "native-stream-probe",
        file: join(context.root, "build/ffmpeg/ffprobe.exe"),
        args: ["-v", "error", "-count_frames", "-show_streams", "-of", "json", mp4Path],
      },
      context,
    );
    assert.equal(report.probe.status, "passed");
    const probeLog = await readFile(join(context.root, report.probe.log), "utf8");
    const stream = JSON.parse(probeLog.slice(probeLog.indexOf("\n") + 1)).streams[0];
    assert.equal(stream.nb_read_frames, "60");
    assert.equal(stream.avg_frame_rate, "30000/1001");
    assert.equal(stream.width, video.size.width);
    assert.equal(stream.height, video.size.height);
    assert.equal(stream.has_b_frames, 0);
    assert.equal(stream.color_range, "tv");
    assert.equal(stream.color_space, "bt709");
    assert.equal(stream.start_time, "0.000000");
    assert(Math.abs(Number(stream.duration) - 2.002) < 0.00001);
    report.stream = stream;
    const decodedPath = join(context.output, "decoded.rgba");
    report.decode = await execute(
      {
        id: "native-stream-decode",
        file: join(context.root, "build/ffmpeg/ffmpeg.exe"),
        args: [
          "-v",
          "error",
          "-i",
          mp4Path,
          "-pix_fmt",
          "rgba",
          "-f",
          "rawvideo",
          "-n",
          decodedPath,
        ],
      },
      context,
    );
    assert.equal(report.decode.status, "passed");
    const decodedLog = await readFile(join(context.root, report.decode.log), "utf8");
    assert.equal(decodedLog.slice(decodedLog.indexOf("\n") + 1).trim(), "");
    assert.equal((await stat(decodedPath)).size, 60 * video.size.width * video.size.height * 4);
    report.decoded_output = { path: local(decodedPath), sha256: await hashFile(decodedPath) };
    const cancelled = await run(
      "cancel",
      [
        begin(60),
        frame(0),
        frame(1),
        control({ type: "cancel_export" }),
        frame(2),
        control({ type: "finish_export" }),
      ],
      [],
      true,
    );
    assert.equal(cancelled.replies[3].type, "export_cancelled");
    assert.equal(cancelled.replies[3].encoder.accepted_frames, 2);
    assert.equal(cancelled.replies[3].encoder.cancelled, true);
    assert.equal(cancelled.replies[3].encoder.drain_completed, false);
    assert(cancelled.replies.slice(4).every((r) => r.type === "error"));
    const restarted = await run(
      "cancel-restart",
      [
        begin(60),
        frame(0),
        control({ type: "cancel_export" }),
        begin(3),
        frame(0),
        frame(1),
        frame(2),
        control({ type: "finish_export" }),
      ],
      [],
      true,
    );
    assert(restarted.replies.every((r) => r.type !== "error"));
    assert.equal(restarted.replies[2].encoder.cancelled, true);
    assert.equal(restarted.replies.at(-1).encoder.encoded_frames, 3);
    assert.equal(restarted.replies.at(-1).complete, true);
    for (const [name, commands, extra] of [
      ["early-finish", [begin(60), frame(0), control({ type: "finish_export" }), frame(1)], []],
      ["wrong-order", [begin(60), frame(1), frame(0)], []],
      [
        "late-warmup",
        [begin(60), frame(0), control({ type: "warm_frame", plan_bytes: plan.length }, plan)],
        [],
      ],
      [
        "missing-resource",
        [
          begin(60),
          frame(0),
          control({ type: "evict_resource", hash: resources[0].hash }),
          frame(1),
          control({ type: "finish_export" }),
        ],
        [],
      ],
      [
        "packet-budget",
        [begin(3), frame(0), frame(1), frame(2), control({ type: "finish_export" })],
        ["--max-encoder-packet-bytes", "64"],
      ],
      ["gpu-budget", [begin(3), frame(0)], ["--gpu-budget-bytes", "1024"]],
    ]) {
      const rejected = await run(name, commands, extra, true);
      assert(
        rejected.replies.some((r) => r.type === "error"),
        `${name}: rejection missing`,
      );
      assert(
        rejected.replies.every((r) => !r.complete),
        `${name}: failure reported completion`,
      );
      assert.equal(rejected.replies.at(-1).type, "error");
    }
    if (transport === "auto") {
      const fallback = await run(
        "readback-fallback",
        [begin(3), frame(0), frame(1), frame(2), control({ type: "finish_export" })],
        ["--max-encoder-input-bytes", String((video.size.width * video.size.height * 3) / 2)],
      );
      assert(fallback.replies.every((reply) => reply.type !== "error"));
      assert.equal(fallback.replies[0].transport, "nv12-readback");
      assert.match(
        fallback.replies[0].transport_reason,
        /GPU encoder probe exceeds retained input budget/,
      );
      assert.equal(fallback.replies.at(-1).complete, true);
      assert.equal(fallback.replies.at(-1).encoder.gpu_input_frames, 0);
      assert.equal(fallback.replies.at(-1).encoder.encoded_frames, 3);
      assert.equal(fallback.packets.length, 3);
    }
    report.output = { path: local(mp4Path), sha256: await hashFile(mp4Path) };
    report.checked_files = await reader.stable();
    assert.equal(await hashFile(binary), report.binary.sha256);
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
    options: {
      out: { type: "string" },
      binary: { type: "string" },
      transport: { type: "string", default: "readback" },
    },
  });
  assert(values.out && values.binary, "--out and --binary are required");
  const root = process.cwd();
  const report = await runNativeExportStreamGate(
    { root, output: resolve(values.out), env: process.env },
    {
      binary: resolve(values.binary),
      compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
      transport: values.transport,
    },
  );
  console.log(`${report.status}: ${report.checks.length} native export stream checks`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
