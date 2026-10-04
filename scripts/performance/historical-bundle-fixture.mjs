import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { sha256 } from "../migration/m0-evidence.mjs";
import { captureSource, digest } from "../parity/provenance.mjs";
import { measurementFixture } from "./measurement-fixtures.mjs";
import { freezePreviewBaseline } from "./preview-baseline.mjs";

/** CPU-only test data: the bundle and bridge bytes are stubs, never GPU observations. */
export async function historicalBundleFixture(t, root) {
  if (!root) {
    const fixture = await measurementFixture(t);
    root = fixture.root;
    await fixture.baselinePreview();
    const frozen = await freezePreviewBaseline(root, "artifacts/preview.json");
    fixture.ledger.milestones[0].preview_baseline_path = frozen.path;
    fixture.ledger.milestones[0].preview_baseline_sha256 = frozen.sha256;
    await fixture.write("docs/migration/rust-renderer-progress.json", fixture.ledger);
  }
  root = resolve(root);
  assert(
    basename(root).startsWith("aster-measurement-test-") &&
      !relative(tmpdir(), root).startsWith(".."),
    "Historical fixtures may only write their temporary measurement checkout",
  );
  const read = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  const bytes = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  };
  const write = async (path, value) => bytes(path, `${JSON.stringify(value, null, 2)}\n`);
  const hash = async (path) => sha256(await readFile(join(root, path)));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  await bytes("electron/main.ts", "export const historicalHost = true;\n");
  await bytes("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  git("add", "--", "electron/main.ts", "pnpm-lock.yaml");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `core.hooksPath=${join(root, "empty-hooks")}`,
    "commit",
    "-qm",
    "🧪 Add historical Electron fixture",
  );
  const commit = git("rev-parse", "HEAD");
  const ledgerPath = "docs/migration/rust-renderer-progress.json";
  const ledger = await read(ledgerPath);
  const milestone = ledger.milestones.find((item) => item.id === "M2");
  milestone.pre_plan_renderer_commit = commit;
  await write(ledgerPath, ledger);
  const source = await captureSource(root);
  const previewBaselinePath = milestone.preview_baseline_path;
  const preview = await read(previewBaselinePath);
  const previewReport = preview.observation;
  Object.assign(previewReport, {
    source,
    source_after: source,
    source_before_build: { source_sha256: source.tree_sha256 },
  });
  Object.assign(preview.pre_plan, {
    renderer_commit: commit,
    source_sha256: source.tree_sha256,
    existing_production_file_count: 2,
  });
  await write(preview.evidence.report, previewReport);
  preview.evidence.sha256 = await hash(preview.evidence.report);
  preview.observation_sha256 = digest(previewReport);
  await write(previewBaselinePath, preview);
  milestone.preview_baseline_sha256 = await hash(previewBaselinePath);

  const baseline = await read("benchmarks/results/migration-baseline.json");
  const cases = (
    await Promise.all(baseline.measurements.map((item) => read(item.raw_data)))
  ).flat();
  const originDirectory = "artifacts/performance/test-historical";
  const directory = `${originDirectory}/web`;
  const reportPath = `${originDirectory}/report.json`;
  const configPath = `${originDirectory}/config.json`;
  const report = {
    ...previewReport,
    suite: "throughput",
    run_id: "test-historical",
    cases,
    measurements: baseline.measurements,
    method: baseline.method,
  };
  const config = {
    source,
    runId: report.run_id,
    assignments: cases.map((item) => ({
      case: item.inputs.case,
      caseHash: item.case_hash,
      inputs: item.inputs,
      benchmark: item.benchmark,
    })),
  };
  await write(reportPath, report);
  await write(configPath, config);
  const bundleContents = [
    { path: `${directory}/assets/harness.js`, contents: "// CPU-only historical bundle fixture\n" },
    {
      path: `${directory}/tests/performance/harness.html`,
      contents: '<script type="module" src="/assets/harness.js"></script>\n',
    },
  ];
  for (const file of bundleContents) await bytes(file.path, file.contents);
  const files = await Promise.all(
    bundleContents.map(async (file) => ({ path: file.path, sha256: await hash(file.path) })),
  );
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const bundle = {
    report: reportPath,
    report_sha256: await hash(reportPath),
    config: configPath,
    config_sha256: await hash(configPath),
    directory,
    files,
    sha256: digest(files),
    original_renderer_source: source,
  };
  const abPath = "artifacts/migration/historical-ab.json";
  await write(abPath, {
    kind: "prebuilt-bundle-performance-diagnostic",
    status: "passed",
    bundles: { current: bundle },
  });
  const task = milestone.tasks.find((item) => item.id === "M2-T1");
  task.performance_diagnostics = {
    interleaved_bundles: { path: abPath, sha256: await hash(abPath) },
  };
  await write(ledgerPath, ledger);
  return {
    root,
    ledger,
    source,
    commit,
    read,
    write,
    bytes,
    hash,
    ledgerPath,
    abPath,
    previewBaselinePath,
    previewReportPath: preview.evidence.report,
    reportPath,
    configPath,
    directory,
    bundle,
    electronPath: "electron/main.ts",
  };
}
