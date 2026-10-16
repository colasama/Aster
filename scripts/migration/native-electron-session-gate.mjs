import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Exercise the production Node transport and mux; queue routing/preflight remain separate gates. */
export async function runNativeElectronSessionGate(
  context,
  { binary, compiler },
  execute = runStep,
) {
  const report = {
    status: "failed",
    native_export_acceptance: false,
    checks: [],
    initializations: [],
  };
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  await mkdir(context.output, { recursive: true });
  try {
    const compile = await execute(
      { id: "electron-native-compile", file: "pnpm", args: ["electron:compile"] },
      context,
    );
    assert.equal(compile.status, "passed");
    report.compile = compile;
    const { prepareNativeEncoder } = await import(
      pathToFileURL(join(context.root, "dist-electron/electron/native-encoder-preflight.js"))
    );
    const { NativeExportSession } = await import(
      pathToFileURL(join(context.root, "dist-electron/electron/native-export-session.js"))
    );
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    report.modules = [];
    for (const name of [
      "native-render-client",
      "native-encoder-preflight",
      "native-render-protocol",
      "native-export-session",
      "mp4-export",
    ]) {
      const path = join(context.root, `dist-electron/electron/${name}.js`);
      report.modules.push({ path: local(path), sha256: await hashFile(path) });
    }
    const reader = new M0Evidence(context.root);
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pin = ledger.milestones.find((m) => m.id === "M3").input_manifest;
    const manifest = await reader.json(pin.path, pin.sha256);
    const base = posix.dirname(pin.path);
    const fixture = manifest.frames.find((f) => f.case_id === "shape-rectangle" && f.frame === 0);
    assert(fixture);
    const meta = await reader.json(`${base}/${fixture.meta_path}`, fixture.meta_sha256);
    const files = meta.frame_plan.files;
    const plan = (await reader.bytes(`${base}/shape-rectangle/0/replay.fpln`, files["replay.fpln"]))
      .bytes;
    const resources = await reader.json(
      `${base}/shape-rectangle/0/resources.json`,
      files["resources.json"],
    );
    const ffmpeg = join(context.root, "build/ffmpeg/ffmpeg.exe");
    const ffprobe = join(context.root, "build/ffmpeg/ffprobe.exe");
    const run = (executable, args) =>
      new Promise((done, reject) => {
        execFile(
          executable,
          args,
          { windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}: ${stderr}`)) : done(stdout),
        );
      });
    const request = {
      outputPath: join(context.output, "audiovisual.mp4"),
      width: meta.size.width,
      height: meta.size.height,
      frameRateNumerator: 30000,
      frameRateDenominator: 1001,
      frameCount: 60,
      pixelFormat: "rgba",
      videoBitrateBps: 8_000_000,
      audio: { sampleRate: 48000, channels: 2, frameCount: 96096 },
    };
    const open = async (value, phase) => {
      const clients = [];
      try {
        const { client, reply } = await prepareNativeEncoder({
          binary,
          args: compiler ? ["--dxcompiler", compiler] : [],
          video: {
            size: { width: value.width, height: value.height },
            frame_rate: {
              numerator: value.frameRateNumerator,
              denominator: value.frameRateDenominator,
            },
            bitrate_bps: value.videoBitrateBps,
          },
          frameCount: value.frameCount,
          own: (client) => clients.push(client),
          assertActive: () => {},
        });
        assert(["nv12-shared", "nv12-readback"].includes(reply.response.transport));
        assert(clients.length >= 1 && clients.length <= 2);
        report.initializations.push({
          phase,
          attempts: clients.length,
          transport: reply.response.transport,
          reason: reply.response.transport_reason,
          adapter_luid: reply.response.adapter_luid,
        });
        for (const { type, ...resource } of resources) {
          const bytes = (
            await reader.bytes(`${base}/shape-rectangle/frame-resources/${resource.hash}.bin`)
          ).bytes;
          validateFrameResource({ type, ...resource }, bytes);
          await client.request({ type, resource, payload_bytes: bytes.length }, bytes);
        }
        const checked = await client.request(
          { type: "check_frame", plan_bytes: plan.length },
          plan,
        );
        assert.equal(checked.response.plan_sha256, sha256(plan));
        return await NativeExportSession.start(client, ffmpeg, value, reply);
      } catch (error) {
        for (const client of clients) await client.dispose();
        throw error;
      }
    };
    const started = Date.now();
    const session = await open(request, "audiovisual");
    try {
      await Promise.all([
        (async () => {
          for (let frame = 0; frame < 60; frame++) await session.render(plan);
        })(),
        (async () => {
          for (let offset = 0; offset < request.audio.frameCount; offset += 4800) {
            const frames = Math.min(4800, request.audio.frameCount - offset);
            const audio = new Float32Array(frames * 2);
            for (let i = 0; i < frames; i++)
              audio[i * 2] = audio[i * 2 + 1] =
                0.2 * Math.sin(((offset + i) * 440 * 2 * Math.PI) / 48000);
            await session.writeAudio(audio.buffer);
          }
        })(),
      ]);
      const output = await session.finish();
      assert.equal(output.encoder, "h264_mf");
      assert.equal(output.frameCount, 60);
      assert.equal(output.audioFrameCount, request.audio.frameCount);
      report.output = output;
      report.elapsed_ms = Date.now() - started;
    } finally {
      await session.cancel();
    }
    const probe = JSON.parse(
      (
        await run(ffprobe, [
          "-v",
          "error",
          "-count_frames",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          request.outputPath,
        ])
      ).toString(),
    );
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    assert.equal(Number(video.nb_read_frames), 60);
    assert.equal(video.r_frame_rate, "30000/1001");
    assert.equal(Number(video.duration), 2.002);
    assert.equal(video.has_b_frames, 0);
    assert.equal(video.color_space, "bt709");
    assert.equal(video.color_range, "tv");
    assert.equal(audio.codec_name, "aac");
    assert.equal(audio.channels, 2);
    assert.equal(Number(audio.sample_rate), 48000);
    assert(Math.abs(Number(audio.duration) - 2.002) <= 1024 / 48000);
    const decoded = await run(ffmpeg, [
      "-v",
      "error",
      "-i",
      request.outputPath,
      "-map",
      "0:v:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-",
    ]);
    assert.equal(decoded.length, request.width * request.height * 4 * 60);
    report.video_sha256 = sha256(decoded);
    report.checks.push({ name: "native-audio-atomic-mux", status: "passed", probe });
    await writeFile(join(context.output, "decoded.rgba"), decoded, { flag: "wx" });
    for (const mode of ["cancel", "missing-frames", "cancel-finish"]) {
      const outputPath = join(context.output, `${mode}.mp4`);
      const sentinel = Buffer.from("existing output must survive a failed or cancelled export");
      await writeFile(outputPath, sentinel, { flag: "wx" });
      const incomplete = await open({ ...request, outputPath, audio: undefined }, mode);
      try {
        await incomplete.render(plan);
        if (mode === "missing-frames") await assert.rejects(incomplete.finish(), /missing frames/);
        else if (mode === "cancel-finish") {
          for (let frame = 1; frame < request.frameCount; frame++) await incomplete.render(plan);
          const finishing = incomplete.finish();
          const rejected = assert.rejects(finishing);
          await incomplete.cancel();
          await rejected;
        } else await incomplete.cancel();
      } finally {
        await incomplete.cancel();
      }
      assert.deepEqual(await readFile(outputPath), sentinel);
      assert(!(await readdir(context.output)).some((name) => name.startsWith(".aster-export-")));
      report.checks.push({ name: `${mode}-preserves-existing-output`, status: "passed" });
    }
    report.status = "passed";
  } catch (error) {
    report.error = error.stack || String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { out: { type: "string" }, binary: { type: "string" }, compiler: { type: "string" } },
  });
  assert(values.out && values.binary, "--out and --binary are required");
  const report = await runNativeElectronSessionGate(
    { root: process.cwd(), output: resolve(values.out), env: process.env },
    { binary: resolve(values.binary), compiler: values.compiler },
  );
  console.log(
    JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error }),
  );
  if (report.status !== "passed") process.exitCode = 1;
}
