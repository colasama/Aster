import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import electron from "electron";
import { nativeReleaseBuild } from "../native-build.mjs";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { decodeRgbaPng } from "../parity/png.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runPreviewCorpus } from "./preview-corpus-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { runSharedPreviewProject } from "./shared-preview-project-gate.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Transport qualification alone cannot accept native project preview or complete M11. */
export async function runSharedPreviewGate(context, execute = runStep) {
  const started = Date.now();
  const report = {
    id: "G3",
    status: "failed",
    scope: "shared-preview-foundation",
    native_preview_acceptance: false,
    full_coverage: false,
    steps: [],
  };
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  await mkdir(context.output, { recursive: true });
  try {
    report.source = await sourceProvenance(context.root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const reader = new M0Evidence(context.root);
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pinned = ledger.milestones.find((m) => m.id === "M3").input_manifest;
    const manifest = await reader.json(pinned.path, pinned.sha256);
    const base = posix.dirname(pinned.path);
    const fixture = manifest.frames.find((f) => f.case_id === "shape-rectangle" && f.frame === 0);
    assert(fixture, "Authenticated transparent shape fixture missing");
    const metadata = await reader.json(`${base}/${fixture.meta_path}`, fixture.meta_sha256);
    const files = metadata.frame_plan.files;
    const plan = `${base}/shape-rectangle/0/replay.fpln`;
    await reader.bytes(plan, files["replay.fpln"]);
    const resources = await reader.json(
      `${base}/shape-rectangle/0/resources.json`,
      files["resources.json"],
    );
    for (const resource of resources) {
      assert.equal(resource.type, "put_resource");
      const payload = await reader.bytes(
        `${base}/shape-rectangle/frame-resources/${resource.hash}.bin`,
      );
      validateFrameResource(resource, payload.bytes);
    }
    const reference = await reader.bytes(`${base}/${fixture.path}`, fixture.png_sha256);
    const rgba = decodeRgbaPng(reference.bytes);
    assert.equal(sha256(rgba.pixels), fixture.rgba_sha256);
    report.input = {
      manifest: pinned,
      plan: { path: plan, sha256: files["replay.fpln"] },
      reference: {
        path: `${base}/${fixture.path}`,
        sha256: fixture.png_sha256,
        rgba_sha256: fixture.rgba_sha256,
      },
      resources: resources.map((r) => r.hash),
    };
    for (const command of [
      nativeReleaseBuild("preview-native-build"),
      {
        id: "preview-owned-surface",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-renderer",
          "shared_preview_bgra_preserves_alpha_and_owns_reuse",
          "--",
          "--ignored",
        ],
        timeout_ms: 300000,
      },
      { id: "preview-electron-compile", file: "pnpm", args: ["electron:compile"] },
      {
        id: "preview-raster-build",
        file: process.execPath,
        args: ["scripts/build-native-raster.mjs"],
      },
    ]) {
      const step = await execute(command, context);
      report.steps.push(step);
      assert.equal(step.status, "passed", `${command.id} failed`);
    }
    const binary = join(context.root, "target/release/aster-render-cli.exe");
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    const destination = join(context.output, "electron");
    await mkdir(destination);
    const config = join(context.output, "config.json");
    await writeAtomicJson(config, {
      root: context.root,
      output: destination,
      binary,
      compiler: join(context.root, "node_modules/electron/dist/dxcompiler.dll"),
      plan: join(context.root, plan),
      resources: join(context.root, base, "shape-rectangle/frame-resources"),
      reference: join(context.root, base, fixture.path),
    });
    const step = await execute(
      {
        id: "preview-electron",
        file: electron,
        args: ["scripts/migration/shared-preview-electron.mjs"],
        env: { ASTER_SHARED_PREVIEW_CONFIG: config },
        timeout_ms: 180000,
      },
      context,
    );
    report.steps.push(step);
    const path = join(destination, "report.json");
    const witness = JSON.parse(await readFile(path, "utf8"));
    assert.equal(step.status, "passed", witness.error);
    assert.equal(witness.status, "passed", witness.error);
    assert.deepEqual(witness.ready.source, { kind: "plan", sha256: files["replay.fpln"] });
    assert.equal(witness.all_references_released, true);
    assert.equal(witness.unregistered_receiver_rejected, true);
    assert.equal(witness.frames.length, 12);
    for (const [index, frame] of witness.frames.entries()) {
      assert.equal(frame.sequence, index + 1);
      assert.equal(frame.exact, true);
      assert.equal(frame.rgba_sha256, fixture.rgba_sha256);
      const png = await reader.bytes(local(join(destination, `frame-${index + 1}.png`)));
      assert.equal(sha256(decodeRgbaPng(png.bytes).pixels), fixture.rgba_sha256);
    }
    report.transport = {
      status: "passed",
      evidence: { path: local(path), sha256: await hashFile(path) },
      exact_frames: 12,
      alpha: "premultiplied-bgra-preserved",
      bounded_slots: 2,
      gpu_to_gpu: true,
      diagnostic_readback_only_in_witness: true,
    };
    report.project_transport = await runSharedPreviewProject(
      context,
      execute,
      reader,
      manifest,
      base,
      binary,
    );
    report.steps.push(report.project_transport.step);
    report.corpus = await runPreviewCorpus(
      { ...context, output: join(context.output, "corpus"), source: report.source },
      execute,
    );
    assert.equal(report.corpus.status, "passed", report.corpus.error);
    assert.equal(report.corpus.full_coverage, true);
    assert.equal(await hashFile(binary), report.binary.sha256);
    report.authenticated_files = await reader.stable();
    report.source_after = await sourceProvenance(context.root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    report.status = "passed";
    report.full_coverage = true;
    report.native_preview_acceptance = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
