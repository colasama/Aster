import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { decodeRgbaPng, encodeRgbaPng } from "../parity/png.mjs";
import { captureDiagnosticStructuralWitness } from "./diagnostic-structural-witness.mjs";
import { compareEncodedFrames } from "./encoded-quality-frames.mjs";
import { scoreExportSamples } from "./export-quality.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { exportNativeQualityJob } from "./native-quality-job.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Diagnostic matched-bit-rate case; full corpus/owner coverage and self-review remain required. */
export async function runNativeEncodedQualityCase(context, options) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = { status: "failed", native_export_acceptance: false, comparisons: [] };
  const reader = new M0Evidence(root);
  let grants, client, native, retained;
  try {
    report.source = await sourceProvenance(root);
    const binary = join(root, "target/release/aster-render-cli.exe");
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    report.input = { path: local(options.capture), sha256: await hashFile(options.capture) };
    const capture = await reader.json(report.input.path, report.input.sha256);
    assert.equal(capture.status, "passed");
    const frames = capture.frames.filter((frame) => frame.mode === options.mode);
    assert.equal(frames.length, 3);
    const manifest = frames[0].job;
    assert(manifest);
    const modules = (name) =>
      import(pathToFileURL(join(root, `dist-electron/electron/${name}.js`)));
    const { NativeRenderClient } = await modules("native-render-client");
    const { NativeExportSession } = await modules("native-export-session");
    const { NativeMediaGrants } = await modules("native-media-grants");
    const { NativeResourceWindow } = await modules("native-resource-window");
    const { Mp4ExportManager } = await modules("mp4-export");
    const packets = [],
      references = [];
    for (const [index, frame] of frames.entries()) {
      assert.deepEqual(frame.job, manifest);
      const plan = (await reader.bytes(frame.plan.path, frame.plan.sha256)).bytes;
      const metadata = JSON.parse(plan.subarray(32, 32 + plan.readUInt32LE(8)));
      const resources = [];
      for (const resource of frame.resources.filter((r) =>
        metadata.resources.includes(r.message.hash),
      )) {
        const bytes = (
          await reader.bytes(
            local(join(dirname(options.capture), "resources", `${resource.message.hash}.bin`)),
            resource.sha256,
          )
        ).bytes;
        resources.push({ message: resource.message, bytes });
      }
      packets.push({ plan, resources });
      const reference = decodeRgbaPng(
        (await reader.bytes(frame.reference.path, frame.reference.sha256)).bytes,
      );
      // MP4 discards alpha in both existing raw FFmpeg and native NV12 paths. Preserve RGB exactly.
      for (let offset = 3; offset < reference.pixels.length; offset += 4)
        reference.pixels[offset] = 255;
      references.push(join(output, `reference-${index}.png`));
      await writeFile(
        join(output, `reference-${index}.png`),
        encodeRgbaPng(reference.width, reference.height, reference.pixels),
        { flag: "wx" },
      );
    }
    const ffmpeg = join(root, "build/ffmpeg/ffmpeg.exe");
    const request = {
      outputPath: join(output, "native.mp4"),
      width: manifest.width,
      height: manifest.height,
      frameRateNumerator: manifest.frameRate.numerator,
      frameRateDenominator: manifest.frameRate.denominator,
      frameCount: frames.length,
      videoBitrateBps: Math.round(manifest.outputs[0].bitrateMbps * 1000000),
      pixelFormat: "rgba",
    };
    const video = {
      size: { width: request.width, height: request.height },
      frame_rate: manifest.frameRate,
      bitrate_bps: request.videoBitrateBps,
    };
    const controls = [
      ...(options.quality !== undefined
        ? ["--encoder-quality-vs-speed", String(options.quality)]
        : []),
      ...(options.rate !== undefined ? ["--encoder-rate-control", String(options.rate)] : []),
      ...(options.maxQp !== undefined ? ["--encoder-max-qp", String(options.maxQp)] : []),
    ];
    report.quality_controls = controls;
    report.production_route = controls.length === 0;
    if (report.production_route) {
      const result = await exportNativeQualityJob(root, output, manifest, packets);
      report.native = result.output;
      report.native_transport = result.transport;
    } else {
      grants = await NativeMediaGrants.create(join(output, "temporary"), manifest, []);
      client = new NativeRenderClient({
        executable: binary,
        args: [
          "serve",
          "--native-readback-export",
          "--dxcompiler",
          join(root, "node_modules/electron/dist/dxcompiler.dll"),
          "--media-authorizations",
          grants.path,
          "--ffmpeg",
          ffmpeg,
          "--ffprobe",
          join(root, "build/ffmpeg/ffprobe.exe"),
          ...controls,
        ],
      });
      report.probe = (await client.request({ type: "probe", adapter_luid: null, video })).response;
      assert.equal(report.probe.encoder.test_frame_verified, true);
      const window = new NativeResourceWindow(client);
      for (const packet of packets) {
        await window.install(packet);
        await client.request({ type: "check_frame", plan_bytes: packet.plan.length }, packet.plan);
      }
      native = await NativeExportSession.start(client, ffmpeg, request);
      for (const packet of packets) {
        await window.install(packet);
        await native.render(packet.plan);
      }
      report.native = await native.finish();
    }
    retained = new Mp4ExportManager(ffmpeg);
    const ts = await retained.start({ ...request, outputPath: join(output, "ts.mp4") }, 0);
    for (const path of references) {
      const reference = decodeRgbaPng(await readFile(path));
      await retained.write(ts.jobId, Uint8Array.from(reference.pixels).buffer, 0);
    }
    report.retained_ts = await retained.finish(ts.jobId, 0);
    const run = (args, executable = ffmpeg) =>
      new Promise((done, reject) =>
        execFile(
          executable,
          args,
          {
            cwd: output,
            windowsHide: true,
            timeout: 60000,
            encoding: "buffer",
            maxBuffer: 64 * 1024 * 1024,
          },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}: ${stderr}`)) : done(stdout),
        ),
      );
    report.outputs = {};
    for (const name of ["native", "ts"]) {
      const probe = JSON.parse(
        await run(
          [
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            `${name}.mp4`,
          ],
          join(root, "build/ffmpeg/ffprobe.exe"),
        ),
      );
      const streams = probe.streams.filter((stream) => stream.codec_type === "video");
      assert.equal(streams.length, 1);
      const stream = streams[0];
      assert.equal(stream.codec_name, "h264");
      assert.equal(Number(stream.nb_read_frames), frames.length);
      assert.equal(stream.width, request.width);
      assert.equal(stream.height, request.height);
      assert.equal(
        stream.avg_frame_rate,
        `${request.frameRateNumerator}/${request.frameRateDenominator}`,
      );
      assert(
        Math.abs(
          Number(stream.duration) -
            (frames.length * request.frameRateDenominator) / request.frameRateNumerator,
        ) < 0.0001,
      );
      report.outputs[name] = {
        path: local(join(output, `${name}.mp4`)),
        sha256: await hashFile(join(output, `${name}.mp4`)),
        probe,
      };
      const compared = await compareEncodedFrames(context, {
        name,
        binary,
        path: join(output, `${name}.mp4`),
        width: request.width,
        height: request.height,
        references,
        caseId: `native-encoded-${options.mode}`,
        isolated: true,
      });
      report.outputs[name].decoded = compared.decoded;
      report.outputs[name].reference_domain = compared.reference_domain;
      report.comparisons.push(...compared.comparisons);
    }
    report.quality = await scoreExportSamples(
      context,
      references.map((path, frame) => ({ path, frame })),
      Object.fromEntries(
        Object.entries(report.outputs).map(([arm, item]) => [
          arm,
          { ...item, path: resolve(root, item.path) },
        ]),
      ),
    );
    if (report.quality.vmaf) report.vmaf = report.quality.vmaf;
    report.relative_quality_passed = report.quality.passed;
    if (report.production_route) {
      const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
      if (ledger.owner_overrides?.layered_structural_policy?.approved)
        report.structural_witness = await captureDiagnosticStructuralWitness(
          { ...context, output: join(output, "structural-witness") },
          report,
          options.mode,
          ledger,
        );
    }
    report.checked_files = await reader.stable();
    assert.equal(await hashFile(binary), report.binary.sha256);
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged, "Sources changed during encoded quality execution");
    report.status = "diagnostic";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await native?.cancel();
    await client?.dispose();
    await retained?.dispose();
    await grants?.dispose();
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      capture: { type: "string" },
      mode: { type: "string", default: "recursive" },
      quality: { type: "string" },
      rate: { type: "string" },
      "max-qp": { type: "string" },
    },
  });
  assert(values.out && values.capture, "--out and --capture are required");
  const report = await runNativeEncodedQualityCase(
    { root: process.cwd(), output: resolve(values.out), env: process.env },
    {
      capture: resolve(values.capture),
      mode: values.mode,
      quality: values.quality === undefined ? undefined : Number(values.quality),
      rate: values.rate === undefined ? undefined : Number(values.rate),
      maxQp: values["max-qp"] === undefined ? undefined : Number(values["max-qp"]),
    },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      vmaf: report.vmaf,
      relative_quality_passed: report.relative_quality_passed,
      error: report.error,
    }),
  );
  process.exitCode = report.status === "failed" ? 1 : 0;
}
