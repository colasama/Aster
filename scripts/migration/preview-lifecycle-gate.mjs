import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import electron from "electron";
import { build } from "vite";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { decodeRgbaPng } from "../parity/png.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Exercise recovery through the production host and canvas with independent frozen pixels. */
export async function runPreviewLifecycle(context, execute = runStep) {
  const { root, output } = context;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = { status: "failed", scope: "native-preview-recovery" };
  await mkdir(output, { recursive: true });
  try {
    report.source = await sourceProvenance(root);
    const inputs = new PixelInputs(context);
    await inputs.loadReferenceCatalog();
    const snapshots = [],
      references = [];
    for (const [index, id] of ["shape-rectangle", "shape-ellipse", "shape-rectangle"].entries()) {
      const item = inputs.corpus.cases.find((item) => item.id === id);
      assert(item);
      const reference = await inputs.baseReference(item, 0);
      await inputs.projectComposition(item, reference.capture);
      const project = await inputs.bytes(join(root, item.project));
      for (const frame of item.frames) {
        const other = await inputs.baseReference(item, frame);
        assert.equal(
          other.meta.rgba_sha256,
          reference.meta.rgba_sha256,
          "Recovery fixture must be time invariant",
        );
      }
      snapshots.push({
        projectDocument: project.bytes.toString("utf8"),
        snapshotScope: `preview-lifecycle:${index}`,
        projectRevision: index,
        compositionId: item.composition,
        ...item.size,
        time: 0,
        antiAliasing: item.aa,
        visualization: "beauty",
        memoryBudgetMb: 512,
      });
      references.push(reference.path);
    }
    const binary = join(root, "target/release/aster-render-cli.exe");
    const bridge = join(root, "target/release/aster-desktop-bridge.exe");
    report.binaries = await Promise.all(
      [binary, bridge].map(async (path) => ({
        path: local(path),
        sha256: await hashFile(path),
      })),
    );
    await build({
      root,
      base: "./",
      configFile: false,
      logLevel: "error",
      build: {
        outDir: join(output, "web"),
        emptyOutDir: false,
        rollupOptions: { input: join(root, "tests/parity/native-preview-witness.html") },
      },
    });
    const capture = join(output, "capture");
    await mkdir(capture);
    const config = join(output, "config.json");
    await writeAtomicJson(config, {
      root,
      output: capture,
      binary,
      bridge,
      compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
      html: join(output, "web/tests/parity/native-preview-witness.html"),
      snapshots,
      references,
      times: [0, 0.5, 59 / 30],
    });
    await inputs.bytes(config);
    report.step = await execute(
      {
        id: "preview-lifecycle",
        file: electron,
        args: ["scripts/migration/preview-app-electron.mjs"],
        env: { ASTER_PREVIEW_APP_CONFIG: config },
        timeout_ms: 240000,
      },
      context,
    );
    const path = join(capture, "report.json");
    const witness = JSON.parse(await readFile(path, "utf8"));
    report.capture = { path: local(path), sha256: await hashFile(path) };
    assert.equal(report.step.status, "passed", witness.error);
    assert.equal(witness.status, "passed", witness.error);
    assert.equal(witness.clean_close, true);
    assert.equal(witness.remaining_private_sessions, 0);
    assert.equal(witness.frames.length, 24);
    assert.equal(witness.snapshots.length, 2);
    for (const [index, frame] of witness.snapshots.entries()) {
      assert.equal(frame.time, 0.234567891);
      assert.equal(frame.generation, 0);
      assert.equal(frame.exact, true);
      assert.equal(frame.normalization, "reference-associated-rgb-to-opaque-editor-canvas");
      const reference = decodeRgbaPng((await inputs.bytes(references[0])).bytes);
      for (let i = 3; i < reference.pixels.length; i += 4) reference.pixels[i] = 255;
      const actual = decodeRgbaPng(await readFile(join(capture, `snapshot-${index}.png`)));
      assert.equal(actual.width, reference.width);
      assert.equal(actual.height, reference.height);
      assert.deepEqual(actual.pixels, reference.pixels);
    }
    assert.equal(witness.producer_crashes.length, 2);
    for (const crash of witness.producer_crashes) assert.equal(crash.producers.length, 1);
    assert.equal(witness.renderer_restart.old_sessions_released, true);
    assert.equal(witness.renderer_restart.reloaded, true);
    assert.equal(witness.renderer_restart.crash.reason, "crashed");
    assert.equal(witness.rounds.length, 2);
    for (const field of [
      "device_loss_recovered",
      "producer_crash_recovered",
      "idle_preserved_canvas",
      "cached_without_native_render",
      "resized",
      "snapshot_preserved_canvas",
    ])
      for (const round of witness.rounds) assert.equal(round[field], true, field);
    for (const [index, frame] of witness.frames.entries()) {
      const address = index % 12;
      assert.equal(frame.generation, address < 9 ? Math.floor(address / 3) : 0);
      const reference = decodeRgbaPng((await inputs.bytes(references[frame.generation])).bytes);
      const actual = decodeRgbaPng(await readFile(join(capture, `frame-${index}.png`)));
      assert.equal(actual.width, reference.width);
      assert.equal(actual.height, reference.height);
      assert.deepEqual(actual.pixels, reference.pixels);
      assert.equal(frame.exact, true);
    }
    await inputs.verifyStable();
    for (const binary of report.binaries)
      assert.equal(await hashFile(join(root, binary.path)), binary.sha256);
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    report.lifecycle = witness.lifecycle;
    report.renderer_restart = witness.renderer_restart;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
