import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Frozen changing media frames exercise whole-job admission, spool replay and resource retirement. */
export async function runNativePreflightMediaGate(
  context,
  { binary, compiler },
  execute = runStep,
) {
  const report = { status: "failed", native_export_acceptance: false, frames: [], rejections: [] };
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const reader = new M0Evidence(context.root);
  let client, spool, session;
  const clients = [];
  await mkdir(context.output, { recursive: true });
  try {
    report.compile = await execute(
      { id: "electron-native-compile", file: "pnpm", args: ["electron:compile"] },
      context,
    );
    assert.equal(report.compile.status, "passed");
    const load = (name) =>
      import(pathToFileURL(join(context.root, `dist-electron/electron/${name}.js`)));
    const { NativeRenderClient } = await load("native-render-client");
    const { prepareNativeEncoder } = await load("native-encoder-preflight");
    const { NativeExportSession } = await load("native-export-session");
    const { NativeExportSpool } = await load("native-export-spool");
    const { NativeResourceWindow } = await load("native-resource-window");
    const { ownNativeFrame } = await load("native-export-input");
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    const preflightModule = join(
      context.root,
      "dist-electron/electron/native-encoder-preflight.js",
    );
    report.preflight_module = {
      path: local(preflightModule),
      sha256: await hashFile(preflightModule),
    };
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const frozen = ledger.reference_baseline.native_media_frame;
    const manifest = await reader.json(frozen.path, frozen.sha256);
    const catalog = await reader.json("tests/parity/assets/media-assets.json");
    const frames = [],
      grants = new Map(),
      assets = new Map();
    const resourceRoot = `${frozen.path.slice(0, frozen.path.lastIndexOf("/"))}/resources`;
    for (const frame of manifest.frames) {
      const plan = (await reader.bytes(frame.plan.path, frame.plan.sha256)).bytes;
      const metadata = JSON.parse(plan.subarray(32, 32 + plan.readUInt32LE(8)));
      const resources = [];
      for (const record of frame.resources.filter((r) =>
        metadata.resources.includes(r.message.hash),
      )) {
        const bytes = (
          await reader.bytes(`${resourceRoot}/${record.message.hash}.bin`, record.sha256)
        ).bytes;
        validateFrameResource(record.message, bytes);
        const source = record.message;
        if (source.kind === "media_source" && source.descriptor.media_kind !== "raster") {
          const asset = catalog.assets[source.descriptor.source_id];
          assert(asset);
          assert.equal(source.descriptor.content_identity, `sha256:${asset.sha256}`);
          if (!assets.has(asset.sha256)) {
            const path = join(context.output, source.descriptor.source_id);
            await writeFile(path, Buffer.from(asset.data, "base64"), { flag: "wx" });
            await reader.bytes(local(path), asset.sha256);
            assets.set(asset.sha256, path);
          }
          grants.set(source.hash, {
            source: source.hash,
            scope: source.descriptor.authorization_scope,
            sha256: asset.sha256,
            path: assets.get(asset.sha256),
          });
        }
        resources.push({ message: source, bytes: Uint8Array.from(bytes).buffer });
      }
      for (const pixel of metadata.slices[0].media_pixels) {
        const resource = resources.find((r) => r.message.hash === pixel.frame);
        assert.equal(resource.message.descriptor.sample.kind, "raster");
      }
      frames.push({
        id: frame.id,
        header: metadata.header,
        plan: Uint8Array.from(plan).buffer,
        resources,
      });
    }
    assert.equal(frames.length, 6);
    const authorization = join(context.output, "authorizations.json");
    await writeAtomicJson(authorization, [...grants.values()]);
    const ffmpeg = join(context.root, "build/ffmpeg/ffmpeg.exe"),
      ffprobe = join(context.root, "build/ffmpeg/ffprobe.exe");
    const open = (grantsFile) =>
      new NativeRenderClient({
        executable: binary,
        cwd: context.root,
        args: [
          "serve",
          "--native-export",
          "--media-authorizations",
          grantsFile,
          "--ffmpeg",
          ffmpeg,
          "--ffprobe",
          ffprobe,
          ...(compiler ? ["--dxcompiler", compiler] : []),
        ],
      });
    const video = {
      size: { width: 320, height: 180 },
      frame_rate: { numerator: 30, denominator: 1 },
      bitrate_bps: 8_000_000,
    };
    const prepared = await prepareNativeEncoder({
      binary,
      args: [
        "--media-authorizations",
        authorization,
        "--ffmpeg",
        ffmpeg,
        "--ffprobe",
        ffprobe,
        ...(compiler ? ["--dxcompiler", compiler] : []),
      ],
      video,
      frameCount: frames.length,
      own: (owned) => clients.push(owned),
      assertActive: () => {},
    });
    client = prepared.client;
    report.initialization = {
      attempts: clients.length,
      transport: prepared.reply.response.transport,
      reason: prepared.reply.response.transport_reason,
      adapter_luid: prepared.reply.response.adapter_luid,
      probed_adapter_luid: prepared.reply.response.probed_adapter_luid,
      before_admission: true,
    };
    assert([1, 2].includes(clients.length));
    assert(["nv12-shared", "nv12-readback"].includes(report.initialization.transport));
    assert.deepEqual(report.initialization.adapter_luid, report.initialization.probed_adapter_luid);
    if (clients.length === 2) {
      assert.equal(report.initialization.transport, "nv12-readback");
      assert(report.initialization.reason?.length > 0);
    }
    const window = new NativeResourceWindow(client);
    const spoolRoot = join(context.output, "spool");
    spool = await NativeExportSpool.create(spoolRoot, {
      frameCount: frames.length,
      maxBytes: 64 * 1024 * 1024,
      maxResources: 4096,
      maxFrameBytes: 64 * 1024 * 1024,
    });
    for (const [index, frame] of frames.entries()) {
      await spool.append(index, frame, async (owned) => {
        await window.install(owned);
        const checked = await client.request(
          { type: "check_frame", plan_bytes: owned.plan.length },
          owned.plan,
        );
        assert.equal(checked.response.plan_sha256, sha256(owned.plan));
        assert.deepEqual(checked.response.header, frame.header);
        assert.equal(
          checked.response.usage.resources,
          frame.resources.length,
          "Temporary decoded media leaked into the session registry",
        );
        report.frames.push({
          id: frame.id,
          plan_sha256: checked.response.plan_sha256,
          usage: checked.response.usage,
        });
      });
    }
    spool.seal();
    report.spool = spool.statistics;
    const outputPath = join(context.output, "mixed.mp4");
    session = await NativeExportSession.start(
      client,
      ffmpeg,
      {
        outputPath,
        width: 320,
        height: 180,
        frameRateNumerator: 30,
        frameRateDenominator: 1,
        frameCount: 6,
        pixelFormat: "rgba",
        videoBitrateBps: 8_000_000,
      },
      prepared.reply,
    );
    for (let index = 0; index < frames.length; index++) {
      const owned = await spool.read(index);
      await window.install(owned);
      await session.render(owned.plan);
    }
    report.export = await session.finish();
    const probe = await new Promise((done, reject) =>
      execFile(
        ffprobe,
        ["-v", "error", "-count_frames", "-show_streams", "-of", "json", outputPath],
        { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : done(JSON.parse(stdout))),
      ),
    );
    assert.equal(Number(probe.streams[0].nb_read_frames), 6);
    assert.equal(Number(probe.streams[0].duration), 0.2);
    report.probe = probe;
    await spool.dispose();
    assert.deepEqual(await readdir(spoolRoot), []);
    const denied = join(context.output, "denied.json");
    await writeAtomicJson(denied, []);
    const unauthorized = open(denied);
    try {
      const owned = ownNativeFrame(frames[0]);
      await new NativeResourceWindow(unauthorized).install(owned);
      await assert.rejects(
        unauthorized.request({ type: "check_frame", plan_bytes: owned.plan.length }, owned.plan),
        /authoriz|grant/i,
      );
      report.rejections.push({ name: "ungranted-media", status: "passed" });
    } finally {
      await unauthorized.dispose();
    }
    const suppliedPixels = open(authorization);
    try {
      const reference = manifest.frames[0];
      const replay = (await reader.bytes(reference.replay.path, reference.replay.sha256)).bytes;
      const resources = [];
      for (const resource of reference.resources) {
        const bytes = (
          await reader.bytes(`${resourceRoot}/${resource.message.hash}.bin`, resource.sha256)
        ).bytes;
        resources.push({ message: resource.message, bytes: Uint8Array.from(bytes).buffer });
      }
      const owned = ownNativeFrame({ plan: Uint8Array.from(replay).buffer, resources });
      await new NativeResourceWindow(suppliedPixels).install(owned);
      await assert.rejects(
        suppliedPixels.request({ type: "check_frame", plan_bytes: owned.plan.length }, owned.plan),
        /supplied file-media pixels/,
      );
      report.rejections.push({ name: "supplied-file-pixels", status: "passed" });
    } finally {
      await suppliedPixels.dispose();
    }
    report.status = "passed";
  } catch (error) {
    report.error = error.stack || String(error);
  } finally {
    await Promise.allSettled([
      session?.cancel(),
      ...clients.map((owned) => owned.dispose()),
      spool?.dispose(),
    ]);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { out: { type: "string" }, binary: { type: "string" }, compiler: { type: "string" } },
  });
  assert(values.out && values.binary, "--out and --binary are required");
  const report = await runNativePreflightMediaGate(
    { root: process.cwd(), output: resolve(values.out), env: process.env },
    { binary: resolve(values.binary), compiler: values.compiler },
  );
  console.log(
    JSON.stringify({ status: report.status, frames: report.frames.length, error: report.error }),
  );
  if (report.status !== "passed") process.exitCode = 1;
}
