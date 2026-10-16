import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Real queue-shaped jobs authenticate every plan before any MP4 can start. */
export async function runNativeExportJobGate(
  context,
  { binary, compiler, capture },
  execute = runStep,
) {
  const report = { status: "failed", native_export_acceptance: false, jobs: [], rejections: [] };
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  await mkdir(context.output, { recursive: true });
  const reader = new M0Evidence(context.root);
  const live = [];
  try {
    report.compile = await execute(
      { id: "electron-native-job-compile", file: "pnpm", args: ["electron:compile"] },
      context,
    );
    assert.equal(report.compile.status, "passed");
    const { NativeExportJob } = await import(
      pathToFileURL(join(context.root, "dist-electron/electron/native-export-job.js"))
    );
    const { NativeRenderHostExport } = await import(
      pathToFileURL(join(context.root, "dist-electron/electron/native-render-host-export.js"))
    );
    const { parseRenderHostOutputRequest } = await import(
      pathToFileURL(join(context.root, "dist-electron/electron/render-queue-host-protocol.js"))
    );
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    report.input = { path: local(capture), sha256: await hashFile(capture) };
    const input = await reader.json(report.input.path, report.input.sha256);
    assert.equal(input.status, "passed");
    assert.equal(input.frames.length, 6);
    const groups = new Map();
    for (const frame of input.frames) {
      assert(
        frame.job &&
          frame.plan_only_exact &&
          frame.plan_only_final_output_accesses === 0 &&
          frame.plan_only_file_pixel_captures === 0,
      );
      const plan = (await reader.bytes(frame.plan.path, frame.plan.sha256)).bytes;
      const metadata = JSON.parse(plan.subarray(32, 32 + plan.readUInt32LE(8)));
      const resources = [];
      for (const resource of frame.resources.filter((r) =>
        metadata.resources.includes(r.message.hash),
      )) {
        const path = join(dirname(capture), "resources", `${resource.message.hash}.bin`);
        const bytes = (await reader.bytes(local(path), resource.sha256)).bytes;
        resources.push({ message: resource.message, bytes: Uint8Array.from(bytes).buffer });
      }
      const group = groups.get(frame.job.id) ?? { manifest: frame.job, frames: [] };
      assert.deepEqual(group.manifest, frame.job);
      group.frames.push({ plan: Uint8Array.from(plan).buffer, resources });
      groups.set(frame.job.id, group);
    }
    const ffmpeg = join(context.root, "build/ffmpeg/ffmpeg.exe"),
      ffprobe = join(context.root, "build/ffmpeg/ffprobe.exe");
    const options = (manifest, name) => ({
      manifest,
      authorizedPaths: [],
      binary,
      compiler,
      ffmpeg,
      ffprobe,
      temporaryRoot: join(context.output, `${name}-temporary`),
      outputPath: join(context.output, `${name}.mp4`),
    });
    const make = (configuration) => {
      const job = new NativeExportJob(configuration);
      live.push(job);
      return job;
    };
    for (const [id, group] of groups) {
      const config = options(group.manifest, id);
      const decisions = [];
      const job = new NativeRenderHostExport({
        manifest: config.manifest,
        runtime: config,
        ffmpeg,
        authorizedPaths: () => [],
        outputPath: () => config.outputPath,
        report: (decision) => decisions.push(decision),
      });
      live.push(job);
      const send = async (request) => {
        const reply = await job.output(
          parseRenderHostOutputRequest({
            jobId: id,
            leaseId: "test-lease",
            outputId: "video",
            ...request,
          }),
        );
        assert.equal(reply.handled, true);
        return reply.value;
      };
      const start = { type: "startMp4", pixelFormat: "rgba", videoBitrateBps: 8_000_000 };
      assert.deepEqual(await send({ type: "prepareNative" }), { accepted: true, reason: null });
      await assert.rejects(send(start), /incompatible/);
      for (const [index, packet] of group.frames.entries())
        assert.deepEqual(await send({ type: "admitNative", frame: index, packet }), {
          accepted: true,
          reason: null,
        });
      assert.equal(job.statistics.frames, 3);
      assert.equal(job.statistics.sealed, false);
      assert(
        (await readdir(config.temporaryRoot)).every(
          (name) => !name.startsWith("aster-native-export-"),
        ),
        "Production admission must not persist unused raw frame spools",
      );
      assert.deepEqual(await send({ type: "sealNative" }), { accepted: true, reason: null });
      assert.deepEqual(decisions, [{ accepted: true, reason: null }]);
      assert.deepEqual(await send(start), { encoder: "h264_mf" });
      await assert.rejects(
        send({ type: "writeMp4Frame", pixels: new ArrayBuffer(16) }),
        /incompatible/,
      );
      await assert.rejects(send({ type: "renderNativeFrame", frame: 1 }), /out of order/);
      for (let index = 0; index < 3; index++)
        await send({ type: "renderNativeFrame", frame: index });
      const result = await send({ type: "finishMp4" });
      assert.equal(job.unfinished, false);
      assert.equal(result.encoder, "h264_mf");
      assert.equal(result.frameCount, 3);
      const probe = await new Promise((done, reject) =>
        execFile(
          ffprobe,
          ["-v", "error", "-count_frames", "-show_streams", "-of", "json", config.outputPath],
          { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : done(JSON.parse(stdout))),
        ),
      );
      assert.equal(Number(probe.streams[0].nb_read_frames), 3);
      assert.equal(probe.streams[0].r_frame_rate, "30/1");
      assert.equal(Number(probe.streams[0].duration), 0.1);
      report.jobs.push({ id, frames: 3, routing: decisions, output: result, probe });
      await job.dispose();
      assert.deepEqual(await readdir(config.temporaryRoot), []);
    }
    const group = groups.values().next().value;
    const warmedConfig = options(group.manifest, "warmed-export");
    const warmed = make(warmedConfig);
    assert.equal((await warmed.prepare()).accepted, true);
    for (let index = 0; index < 10; index++) {
      const frame = index % group.frames.length;
      assert.deepEqual(await warmed.warm(frame, group.frames[frame]), {
        accepted: true,
        reason: null,
      });
      assert.equal(warmed.statistics.frames, 0);
      assert.equal(warmed.transport.compressed.frames, 0);
    }
    report.warmup = { ...warmed.transport.warmup };
    assert.equal(report.warmup.frames, 10);
    for (const [index, packet] of group.frames.entries())
      assert.deepEqual(await warmed.admit(index, packet), { accepted: true, reason: null });
    assert.deepEqual(await warmed.seal(), { accepted: true, reason: null });
    await warmed.start();
    for (let index = 0; index < group.frames.length; index++) await warmed.render(index);
    report.warmed_output = await warmed.finish();
    assert.equal(report.warmed_output.frameCount, group.frames.length);
    await warmed.dispose();
    assert.deepEqual(await readdir(warmedConfig.temporaryRoot), []);
    for (const scenario of [
      "foreign-warmup",
      "late-warmup",
      "foreign-job",
      "late-foreign-frame",
      "missing-frame",
      "cancel-export",
      "cancel-prepare",
      "unsupported-output",
    ]) {
      const manifest = structuredClone(group.manifest);
      if (scenario === "foreign-job" || scenario === "foreign-warmup") manifest.id = "another-job";
      if (scenario === "unsupported-output") manifest.outputs[0].codec = "h265";
      const config = options(manifest, scenario);
      const sentinel = Buffer.from("existing destination");
      await writeFile(config.outputPath, sentinel, { flag: "wx" });
      const job = make(config);
      let reason;
      if (scenario === "cancel-prepare") {
        const preparing = job.prepare();
        await job.dispose();
        const result = await preparing;
        assert.equal(result.accepted, false);
        reason = result.reason;
      } else if (scenario === "unsupported-output") {
        const result = await job.prepare();
        assert.equal(result.accepted, false);
        reason = result.reason;
      } else {
        assert.equal((await job.prepare()).accepted, true);
        if (scenario === "foreign-warmup" || scenario === "late-warmup") {
          if (scenario === "late-warmup")
            assert.equal((await job.admit(0, group.frames[0])).accepted, true);
          const result = await job.warm(0, group.frames[0]);
          assert.equal(result.accepted, false);
          reason = result.reason;
        } else if (scenario === "late-foreign-frame") {
          assert.equal((await job.admit(0, group.frames[0])).accepted, true);
          assert.deepEqual(await readFile(config.outputPath), sentinel);
          const result = await job.admit(1, group.frames[0]);
          assert.equal(result.accepted, false);
          reason = result.reason;
        } else if (scenario === "foreign-job") {
          const result = await job.admit(0, group.frames[0]);
          assert.equal(result.accepted, false);
          reason = result.reason;
        } else if (scenario === "missing-frame") {
          assert.equal((await job.admit(0, group.frames[0])).accepted, true);
          const result = await job.seal();
          assert.equal(result.accepted, false);
          reason = result.reason;
        } else {
          for (const [index, packet] of group.frames.entries())
            assert.equal((await job.admit(index, packet)).accepted, true);
          assert.equal((await job.seal()).accepted, true);
          await job.start();
          const rendering = job.render(0);
          const observed = rendering.catch((error) => error);
          await job.dispose();
          await observed;
          await assert.rejects(job.render(1), /closed/);
          reason = "Cancelled native job cannot resume";
        }
      }
      await job.dispose();
      assert.deepEqual(await readFile(config.outputPath), sentinel);
      assert.deepEqual(
        await readdir(config.temporaryRoot).catch((e) => {
          if (e.code === "ENOENT") return [];
          throw e;
        }),
        [],
      );
      report.rejections.push({ scenario, reason, status: "passed" });
    }
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  } finally {
    await Promise.allSettled(live.map((job) => job.dispose()));
    await writeAtomicJson(join(context.output, "report.json"), report);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      binary: { type: "string" },
      compiler: { type: "string" },
      capture: { type: "string" },
    },
  });
  assert(values.out && values.binary && values.compiler && values.capture);
  const report = await runNativeExportJobGate(
    { root: process.cwd(), output: resolve(values.out), env: process.env },
    {
      binary: resolve(values.binary),
      compiler: resolve(values.compiler),
      capture: resolve(values.capture),
    },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      jobs: report.jobs.length,
      rejections: report.rejections.length,
      error: report.error,
    }),
  );
  process.exitCode = report.status === "passed" ? 0 : 1;
}
