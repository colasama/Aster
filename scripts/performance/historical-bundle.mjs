import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { evidencePath, M0Evidence, sha256, validSha } from "../migration/m0-evidence.mjs";
import { digest } from "../parity/provenance.mjs";

const handles = new WeakSet();
const production = /^(?:src|electron|shaders)\//;
const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/__tests__\/)/;

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function artifactPath(value) {
  assert(
    evidencePath(value).startsWith("artifacts/"),
    "Historical artifacts must stay in artifacts",
  );
  return value;
}

function git(root, args, input) {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    input,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function historicalProduction(root, commit) {
  const names = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    "src",
    "electron",
    "shaders",
  ])
    .toString("utf8")
    .split("\0")
    .filter((path) => path && !testFile.test(path))
    .sort();
  assert(names.length > 0, "Pre-plan production tree is empty");
  for (const name of names) {
    evidencePath(name);
    assert(!/[\r\n\0]/.test(name), "Invalid Git production path");
  }
  const bytes = git(
    root,
    ["cat-file", "--batch"],
    names.map((name) => `${commit}:${name}\n`).join(""),
  );
  let offset = 0;
  const files = names.map((path) => {
    const end = bytes.indexOf(10, offset);
    assert(end >= offset, "Incomplete Git object header");
    const header = bytes.subarray(offset, end).toString("utf8").split(" ");
    const size = Number(header[2]);
    assert(header[1] === "blob" && Number.isSafeInteger(size) && size >= 0, "Expected Git blob");
    const start = end + 1;
    assert(start + size < bytes.length && bytes[start + size] === 10, "Truncated Git blob");
    offset = start + size + 1;
    return { path, sha256: sha256(bytes.subarray(start, start + size)) };
  });
  assert.equal(offset, bytes.length, "Unexpected Git object data");
  return files;
}

function validateSource(source) {
  validSha(source.tree_sha256);
  validSha(source.bridge_sha256);
  assert(Array.isArray(source.files) && source.files.length > 0);
  const seen = new Set();
  for (const file of source.files) {
    evidencePath(file.path);
    validSha(file.sha256);
    assert(!seen.has(file.path), "Duplicate historical source file");
    seen.add(file.path);
  }
  assert.equal(
    digest({ files: source.files, bridge_sha256: source.bridge_sha256 }),
    source.renderer_source_sha256,
  );
}

function validateOrigin(report, suite, count) {
  assert.equal(report.schema_version, 1);
  assert.equal(report.suite, suite);
  assert.equal(report.status, "passed");
  assert.equal(report.exit_code, 0);
  assert.equal(report.baseline_eligible, true);
  assert.equal(report.source_unchanged, true);
  assert.equal(report.hardware_unchanged, true);
  assert.equal(report.diagnostic, false);
  assert.deepEqual(report.skipped, []);
  assert.equal(report.cases.length, count);
  assert(report.cases.every((item) => item.status === "passed"));
  assert.deepEqual(report.source, report.source_after);
  assert.equal(report.source_before_build.source_sha256, report.source.tree_sha256);
  validateSource(report.source);
}

async function bundleFiles(root, directory, reader) {
  artifactPath(directory);
  const files = [];
  async function visit(path) {
    const absolute = resolve(root, path);
    assert((await lstat(absolute)).isDirectory(), "Bundle directory cannot be a symbolic link");
    assert.equal(
      await realpath(absolute),
      absolute,
      "Bundle directory resolves outside its recorded path",
    );
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else {
        assert(entry.isFile(), "Bundle contains a symbolic link or unsupported entry");
        const file = await reader.bytes(child);
        files.push({ path: child, sha256: file.sha256 });
      }
    }
  }
  await visit(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

/** Only an audited, immutable handle may authorize historical-source performance evidence. */
export function assertHistoricalBundle(handle) {
  assert(
    handles.has(handle),
    "Historical bundle requires an authenticated loadHistoricalBundle handle",
  );
  return handle;
}

/** Reuse the pinned pre-plan artifact; this does not claim the current checkout is historical. */
export async function loadHistoricalBundle(root, { forExecution = false } = {}) {
  assert.equal(typeof forExecution, "boolean", "Historical execution mode must be explicit");
  root = await realpath(resolve(root));
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const milestone = ledger.milestones.find((item) => item.id === "M2");
  const referenceCommit = milestone?.pre_plan_renderer_commit;
  assert(
    typeof referenceCommit === "string" && /^[a-f0-9]{40}$/.test(referenceCommit),
    "Missing pre-plan commit",
  );
  assert.equal(milestone.preview_baseline_path, "benchmarks/results/m2-preview-baseline.json");
  const previewPin = {
    path: milestone.preview_baseline_path,
    sha256: validSha(milestone.preview_baseline_sha256),
  };
  const previewBaseline = await reader.json(previewPin.path, previewPin.sha256);
  assert.equal(previewBaseline.kind, "pre-plan-preview-baseline");
  assert.equal(previewBaseline.status, "passed");
  assert.equal(previewBaseline.pre_plan.renderer_commit, referenceCommit);
  assert.equal(previewBaseline.pre_plan.existing_production_files_unchanged, true);
  assert.equal(previewBaseline.pre_plan.renderer_plan_complete, false);
  assert.equal(digest(previewBaseline.observation), previewBaseline.observation_sha256);
  const previewReportPin = {
    path: artifactPath(previewBaseline.evidence.report),
    sha256: validSha(previewBaseline.evidence.sha256),
  };
  const previewReport = await reader.json(previewReportPin.path, previewReportPin.sha256);
  assert.deepEqual(previewReport, previewBaseline.observation);
  validateOrigin(previewReport, "preview", 12);

  const abPin = milestone.tasks.find((item) => item.id === "M2-T1")?.performance_diagnostics
    ?.interleaved_bundles;
  assert(abPin, "Missing ledger-pinned historical bundle evidence");
  const abAnchor = { path: artifactPath(abPin.path), sha256: validSha(abPin.sha256) };
  const ab = await reader.json(abAnchor.path, abAnchor.sha256);
  assert.equal(ab.kind, "prebuilt-bundle-performance-diagnostic");
  assert.equal(ab.status, "passed");
  const bundle = ab.bundles.current;
  const directory = artifactPath(bundle.directory);
  assert(directory.endsWith("/web"), "Unexpected historical web directory");
  const originDirectory = dirname(directory).replaceAll("\\", "/");
  assert.equal(bundle.report, `${originDirectory}/report.json`);
  assert.equal(bundle.config, `${originDirectory}/config.json`);
  const reportPin = { path: artifactPath(bundle.report), sha256: validSha(bundle.report_sha256) };
  const configPin = { path: artifactPath(bundle.config), sha256: validSha(bundle.config_sha256) };
  const origin = await reader.json(reportPin.path, reportPin.sha256);
  const config = await reader.json(configPin.path, configPin.sha256);
  validateOrigin(origin, "throughput", 36);
  assert.deepEqual(origin.source, bundle.original_renderer_source);
  assert.deepEqual(config.source, origin.source);
  assert.equal(config.runId, origin.run_id);
  assert.equal(config.assignments.length, 36);
  for (const field of ["files", "bridge_sha256", "renderer_source_sha256"])
    assert.deepEqual(
      origin.source[field],
      previewReport.source[field],
      "Historical throughput and preview source differ",
    );
  const files = await bundleFiles(root, directory, reader);
  assert.deepEqual(files, bundle.files, "Historical bundle file set or content changed");
  assert.equal(digest(files), validSha(bundle.sha256), "Historical bundle digest differs");
  assert(files.some((file) => file.path === `${directory}/tests/performance/harness.html`));

  const productionFiles = historicalProduction(root, referenceCommit);
  const observed = new Map(origin.source.files.map((file) => [file.path, file.sha256]));
  for (const file of productionFiles)
    assert.equal(
      observed.get(file.path),
      file.sha256,
      `Historical production differs from pre-plan Git blob: ${file.path}`,
    );
  const extraProduction = origin.source.files.filter(
    (file) =>
      production.test(file.path) &&
      !testFile.test(file.path) &&
      !productionFiles.some((expected) => expected.path === file.path),
  );
  // The unused T1 wire codec existed when this artifact was captured. It is not a production consumer.
  assert(
    extraProduction.every((file) => file.path.startsWith("src/renderer/frame-plan/")),
    "Unexpected post-plan production source in historical artifact",
  );
  const electronFiles = productionFiles.filter((file) => file.path.startsWith("electron/"));
  assert(electronFiles.length > 0, "Historical Electron source is missing");
  const currentElectronNames = () =>
    [
      ...new Set(
        git(root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          "electron",
        ])
          .toString("utf8")
          .split("\0")
          .filter((path) => path && !testFile.test(path)),
      ),
    ].sort();
  const bridgePath = `target/release/aster-desktop-bridge${process.platform === "win32" ? ".exe" : ""}`;
  if (forExecution) {
    assert.deepEqual(
      currentElectronNames(),
      electronFiles.map((file) => file.path).sort(),
      "Public Electron source file set changed",
    );
    for (const file of electronFiles) await reader.bytes(file.path, file.sha256);
    await reader.bytes(bridgePath, origin.source.bridge_sha256);
    for (const file of origin.source.files)
      if (["pnpm-lock.yaml", "Cargo.lock"].includes(file.path))
        await reader.bytes(file.path, file.sha256);
  }
  const provenance = freeze({
    schema_version: 1,
    kind: "pinned-pre-plan-bundle",
    reference_commit: referenceCommit,
    bundle: { directory, sha256: bundle.sha256, files },
    anchors: {
      ledger_ab: abAnchor,
      preview_baseline: previewPin,
      preview_report: previewReportPin,
      origin_report: reportPin,
      origin_config: configPin,
    },
    production: {
      file_count: productionFiles.length,
      files_sha256: digest(productionFiles),
      additional_wire_files: extraProduction,
    },
    bridge: { path: bridgePath, sha256: origin.source.bridge_sha256 },
    electron: { files: electronFiles, sha256: digest(electronFiles) },
    execution_scope:
      "Historical browser bundle and unchanged production Electron/bridge; the current public benchmark harness has separate provenance",
    bundle_hash_recorded_by:
      "Later ledger-pinned AB diagnostic; not a claim of a new historical build",
  });
  const assertStable = async () => {
    await reader.stable();
    assert.deepEqual(
      await bundleFiles(root, directory, reader),
      files,
      "Historical bundle changed during execution",
    );
    if (forExecution)
      assert.deepEqual(
        currentElectronNames(),
        electronFiles.map((file) => file.path).sort(),
        "Public Electron source file set changed",
      );
  };
  await assertStable();
  const handle = Object.freeze({
    directory: join(root, directory),
    rendererSource: freeze(structuredClone(origin.source)),
    provenance,
    forExecution,
    assertStable,
  });
  handles.add(handle);
  return handle;
}
