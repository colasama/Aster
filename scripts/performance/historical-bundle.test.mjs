import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../parity/provenance.mjs";
import { assertHistoricalBundle, loadHistoricalBundle } from "./historical-bundle.mjs";
import { historicalBundleFixture } from "./historical-bundle-fixture.mjs";

test("historical bundle retains its Git source while authenticating and freezing the handle", async (t) => {
  const fixture = await historicalBundleFixture(t);
  await fixture.bytes("src/renderer.ts", "export const renderer = 'current-changed';\n");
  const bundle = await loadHistoricalBundle(fixture.root);
  assert.equal(assertHistoricalBundle(bundle), bundle);
  assert.equal(bundle.provenance.reference_commit, fixture.commit);
  assert.deepEqual(bundle.rendererSource, fixture.source);
  assert.equal(bundle.directory, join(fixture.root, fixture.directory));
  assert.equal(bundle.provenance.production.file_count, 2);
  assert.throws(() => assertHistoricalBundle({ ...bundle }), /authenticated/);
  assert.throws(() => {
    bundle.rendererSource.files[0].sha256 = "0".repeat(64);
  }, TypeError);
  await bundle.assertStable();
});

test("bundle mutation, new files and missing files cannot inherit the pinned artifact identity", async (t) => {
  const fixture = await historicalBundleFixture(t);
  const bundle = await loadHistoricalBundle(fixture.root);
  const path = fixture.bundle.files[0].path;
  const original = await readFile(join(fixture.root, path));
  await fixture.bytes(path, "altered bundle bytes");
  await assert.rejects(loadHistoricalBundle(fixture.root), /file set or content changed/);
  await assert.rejects(bundle.assertStable(), /changed/);
  await fixture.bytes(path, original);
  await fixture.bytes(`${fixture.directory}/injected.js`, "new unpinned module");
  await assert.rejects(loadHistoricalBundle(fixture.root), /file set or content changed/);
  await assert.rejects(bundle.assertStable(), /changed/);
  await rm(join(fixture.root, `${fixture.directory}/injected.js`));
  await rm(join(fixture.root, path));
  await assert.rejects(loadHistoricalBundle(fixture.root), /file set or content changed/);
});

test("changed evidence, Electron source and bridge are rejected before and after loading", async (t) => {
  const fixture = await historicalBundleFixture(t);
  const bundle = await loadHistoricalBundle(fixture.root, { forExecution: true });
  for (const path of [
    fixture.abPath,
    fixture.previewReportPath,
    fixture.electronPath,
    bundle.provenance.bridge.path,
    "pnpm-lock.yaml",
  ]) {
    const original = await readFile(join(fixture.root, path));
    await fixture.bytes(path, Buffer.concat([original, Buffer.from("\nchanged")]));
    await assert.rejects(
      loadHistoricalBundle(fixture.root, { forExecution: true }),
      /SHA-256 differs/,
    );
    await assert.rejects(bundle.assertStable(), /changed/);
    await fixture.bytes(path, original);
  }
  await fixture.bytes("electron/added.ts", "export const added = true;\n");
  await assert.rejects(
    loadHistoricalBundle(fixture.root, { forExecution: true }),
    /Electron source file set changed/,
  );
  await assert.rejects(bundle.assertStable(), /Electron source file set changed/);
});

test("historical audit survives live host upgrades while replay refuses incompatible live inputs", async (t) => {
  const fixture = await historicalBundleFixture(t);
  const audit = await loadHistoricalBundle(fixture.root);
  const replay = await loadHistoricalBundle(fixture.root, { forExecution: true });
  assert.deepEqual(audit.provenance, replay.provenance);
  assert.equal(audit.forExecution, false);
  assert.equal(replay.forExecution, true);
  for (const path of [fixture.electronPath, replay.provenance.bridge.path, "pnpm-lock.yaml"]) {
    const saved = await readFile(join(fixture.root, path));
    await fixture.bytes(path, "new current host version\n");
    const reloadedAudit = await loadHistoricalBundle(fixture.root);
    assert.deepEqual(reloadedAudit.provenance, audit.provenance);
    await audit.assertStable();
    await reloadedAudit.assertStable();
    await assert.rejects(
      loadHistoricalBundle(fixture.root, { forExecution: true }),
      /SHA-256 differs/,
    );
    await assert.rejects(replay.assertStable(), /changed/);
    await fixture.bytes(path, saved);
  }
  await fixture.bytes("electron/next-host-feature.ts", "export const feature = true;\n");
  await audit.assertStable();
  await loadHistoricalBundle(fixture.root);
  await assert.rejects(
    loadHistoricalBundle(fixture.root, { forExecution: true }),
    /Electron source file set changed/,
  );
});

test("self-consistent rewritten source and anchor hashes still fail the immutable Git blob proof", async (t) => {
  const fixture = await historicalBundleFixture(t);
  const altered = structuredClone(fixture.source);
  altered.files.find((file) => file.path === "src/renderer.ts").sha256 = "f".repeat(64);
  altered.renderer_source_sha256 = digest({
    files: altered.files,
    bridge_sha256: altered.bridge_sha256,
  });
  const origin = await fixture.read(fixture.reportPath);
  const config = await fixture.read(fixture.configPath);
  const preview = await fixture.read(fixture.previewBaselinePath);
  const ab = await fixture.read(fixture.abPath);
  for (const report of [origin, preview.observation]) {
    report.source = altered;
    report.source_after = altered;
  }
  config.source = altered;
  await fixture.write(fixture.reportPath, origin);
  await fixture.write(fixture.configPath, config);
  await fixture.write(fixture.previewReportPath, preview.observation);
  preview.observation_sha256 = digest(preview.observation);
  preview.evidence.sha256 = await fixture.hash(fixture.previewReportPath);
  await fixture.write(fixture.previewBaselinePath, preview);
  ab.bundles.current.original_renderer_source = altered;
  ab.bundles.current.report_sha256 = await fixture.hash(fixture.reportPath);
  ab.bundles.current.config_sha256 = await fixture.hash(fixture.configPath);
  await fixture.write(fixture.abPath, ab);
  const milestone = fixture.ledger.milestones[0];
  milestone.preview_baseline_sha256 = await fixture.hash(fixture.previewBaselinePath);
  milestone.tasks[0].performance_diagnostics.interleaved_bundles.sha256 = await fixture.hash(
    fixture.abPath,
  );
  await fixture.write(fixture.ledgerPath, fixture.ledger);
  await assert.rejects(loadHistoricalBundle(fixture.root), /differs from pre-plan Git blob/);
});
