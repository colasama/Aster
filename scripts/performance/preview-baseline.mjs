import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { evidencePath, M0Evidence } from "../migration/m0-evidence.mjs";
import { hashFile, sourceProvenance } from "../migration/source.mjs";
import { captureSource, digest } from "../parity/provenance.mjs";
import { auditPerformanceMeasurement, loadThroughputBaseline } from "./measurement-audit.mjs";

export async function auditPreviewBaseline(root, baselineData) {
  const reader = new M0Evidence(root);
  const path = "benchmarks/results/m2-preview-baseline.json";
  const file = await reader.bytes(path);
  const baseline = await reader.json(path);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const milestone = ledger.milestones.find((item) => item.id === "M2");
  assert.equal(baseline.schema_version, 1);
  assert.equal(baseline.kind, "pre-plan-preview-baseline");
  assert.equal(baseline.status, "passed");
  assert.equal(baseline.pre_plan.renderer_commit, milestone?.pre_plan_renderer_commit);
  assert(/^[a-f0-9]{40}$/.test(baseline.pre_plan.renderer_commit));
  assert.equal(baseline.pre_plan.renderer_plan_complete, false);
  assert.equal(baseline.pre_plan.existing_production_files_unchanged, true);
  assert.deepEqual(
    baseline.pre_plan.tasks,
    Array.from({ length: 14 }, (_, index) => ({ id: `M2-T${index + 2}`, status: "pending" })),
  );
  assert(
    typeof milestone.preview_baseline_sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(milestone.preview_baseline_sha256),
    "Preview baseline must be explicitly pinned in the ledger",
  );
  assert.equal(
    milestone.preview_baseline_path,
    path,
    "Preview baseline path must be explicitly pinned",
  );
  assert.equal(file.sha256, milestone.preview_baseline_sha256, "Pinned preview baseline changed");
  assert.equal(digest(baseline.observation), baseline.observation_sha256);
  const data = baselineData ?? (await loadThroughputBaseline(root));
  assert.equal(baseline.throughput_baseline_sha256, data.sha256);
  const audit = await auditPerformanceMeasurement(root, baseline.observation, {
    suite: "preview",
    baselineData: data,
  });
  assert.equal(baseline.pre_plan.source_sha256, baseline.observation.source.tree_sha256);
  assert.deepEqual(baseline.measurements, audit.measurements);
  await reader.stable();
  return { baseline, sha256: file.sha256, path, audit };
}

/** Create once, before production planning changes; later comparisons never call this publisher. */
export async function freezePreviewBaseline(root, reportPath) {
  root = resolve(root);
  const reader = new M0Evidence(root);
  const path = evidencePath(relative(root, resolve(root, reportPath)).replaceAll("\\", "/"));
  assert(
    path.startsWith("artifacts/"),
    "Only an actual artifact run can establish the preview baseline",
  );
  const file = await reader.bytes(path);
  const report = await reader.json(path);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  assert.equal(ledger.status, "running");
  const milestone = ledger.milestones.find((item) => item.id === "M2");
  assert.equal(milestone?.status, "in_progress");
  assert.equal(milestone.renderer_plan_complete, false);
  const tasks = milestone.tasks
    .filter((task) => task.id !== "M2-T1")
    .map(({ id, status }) => ({ id, status }));
  assert.deepEqual(
    tasks,
    Array.from({ length: 14 }, (_, index) => ({ id: `M2-T${index + 2}`, status: "pending" })),
    "Preview baseline must predate production plan extraction",
  );
  const commit = milestone.pre_plan_renderer_commit;
  assert(
    typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit),
    "Missing pinned pre-plan renderer commit",
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trimEnd();
  const existing = new Set(
    git("ls-tree", "-r", "--name-only", commit, "--", "src", "electron", "shaders")
      .split("\n")
      .filter(Boolean),
  );
  assert(existing.size > 0, "Pinned production tree is empty");
  const changed = git("diff", "--name-only", commit, "--", "src", "electron", "shaders")
    .split("\n")
    .filter((name) => existing.has(name));
  assert.deepEqual(changed, [], "Production source already differs from the pre-plan renderer");
  const source = await sourceProvenance(root);
  assert.equal(
    report.source.tree_sha256,
    source.source_sha256,
    "Preview baseline observation is not from current pre-plan source",
  );
  const data = await loadThroughputBaseline(root);
  const expectedRendererSource = await captureSource(root);
  const audited = await auditPerformanceMeasurement(root, report, {
    suite: "preview",
    baselineData: data,
    sourceSha256: source.source_sha256,
    expectedRendererSource,
  });
  const baseline = {
    schema_version: 1,
    kind: "pre-plan-preview-baseline",
    status: "passed",
    created_at: new Date().toISOString(),
    pre_plan: {
      renderer_commit: commit,
      source_sha256: source.source_sha256,
      renderer_plan_complete: false,
      existing_production_files_unchanged: true,
      existing_production_file_count: existing.size,
      tasks,
    },
    throughput_baseline_sha256: data.sha256,
    evidence: { report: path, sha256: file.sha256 },
    observation_sha256: digest(report),
    observation: report,
    measurements: audited.measurements,
  };
  await reader.stable();
  assert.equal(
    (await sourceProvenance(root)).source_sha256,
    source.source_sha256,
    "Source changed during preview baseline audit",
  );
  assert.deepEqual(
    await captureSource(root),
    expectedRendererSource,
    "Renderer or bridge changed during preview baseline audit",
  );
  const target = join(root, "benchmarks/results/m2-preview-baseline.json");
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(baseline, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Atomic create-new publication: a pre-existing baseline is never replaced.
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    status: "passed",
    path: relative(root, target).replaceAll("\\", "/"),
    sha256: await hashFile(target),
    groups: audited.groups,
    measured_frames: audited.measured_frames,
  };
}
