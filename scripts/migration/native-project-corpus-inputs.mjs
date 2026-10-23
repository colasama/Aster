import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { createServer } from "vite";
import { captureAssignments } from "../parity/provenance.mjs";
import { preserveFrozenProjectSource } from "./frozen-project-source.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** The oracle supplies frame addresses and expected plans, never candidate evaluation or resources. */
export async function prepareProjectCorpusInputs(context, prepared) {
  const { root, output } = context;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const task = ledger.milestones.find((m) => m.id === "M9").tasks.find((t) => t.id === "M9-T16");
  assert.equal(task.status, "done");
  const capture = await reader.json(task.full_capture.path, task.full_capture.sha256);
  const manifest = await reader.json(
    task.plan_reference_manifest.path,
    task.plan_reference_manifest.sha256,
  );
  assert.equal(capture.status, "passed");
  assert.equal(capture.source_unchanged, true);
  assert.equal(manifest.kind, "ts-plan-reference");
  assert.equal(manifest.scope, "full");
  assert.equal(manifest.source_verified, true);
  assert.equal(manifest.random_times_per_case, 64);
  assert.deepEqual(manifest.source, capture.source);
  assert.deepEqual(manifest.source_after, capture.source);
  const referenceSource = await preserveFrozenProjectSource(context, capture.source, reader);
  const corpusFile = await reader.bytes("tests/parity/corpus.json", manifest.corpus_sha256);
  const corpus = JSON.parse(corpusFile.bytes);
  assert.equal(manifest.required_cases, corpus.cases.length);
  assert.deepEqual(
    manifest.cases.map((c) => c.id),
    corpus.cases.map((c) => c.id),
  );
  const assignments = await captureAssignments(root, corpus.cases, context.env, {
    planReferences: true,
  });
  const base = dirname(join(root, task.plan_reference_manifest.path));
  const runtime = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  const jobs = [],
    expected = [];
  try {
    const { decodeFramePlan } = await runtime.ssrLoadModule("/src/renderer/frame-plan/codec.ts");
    for (const [index, assignment] of assignments.entries()) {
      assert(!assignment.unavailable, assignment.unavailable);
      const entry = manifest.cases[index];
      const directory = join(base, entry.id);
      const captured = await reader.json(
        local(join(directory, "capture.json")),
        entry.capture_sha256,
      );
      assert.deepEqual(captured.inputs, assignment.inputs);
      assert.equal(captured.samples.length, assignment.planSamples.samples.length);
      assert.equal(entry.case_sha256, assignment.caseHash);
      const frames = [],
        samples = [];
      let scale;
      for (const [sampleIndex, sample] of captured.samples.entries()) {
        assert.deepEqual(sample.sample, assignment.planSamples.samples[sampleIndex]);
        const sampleDirectory = join(directory, String(sampleIndex));
        const meta = await reader.json(
          local(join(sampleDirectory, "meta.json")),
          sample.meta_sha256,
        );
        assert.equal(meta.frame_plan.ir_cli_sha256, task.capture_validator.sha256);
        assert.equal(meta.time, sample.sample.time);
        assert.equal(meta.case_sha256, assignment.caseHash);
        const planPath = join(sampleDirectory, "replay.fpln");
        const plan = await reader.bytes(local(planPath), meta.frame_plan.files["replay.fpln"]);
        const h = decodeFramePlan(plan.bytes).metadata.header;
        assert.deepEqual(h.target, assignment.case.size);
        assert.equal(h.aa, assignment.case.aa);
        const factor =
          assignment.case.aa === "ssaa4x" ? 4 : assignment.case.aa === "ssaa2x" ? 2 : 1;
        assert.equal(h.render_target.width, h.target.width * factor);
        assert.equal(h.render_target.height, h.target.height * factor);
        scale ??= factor;
        assert.equal(scale, factor);
        frames.push({
          frame: {
            snapshotScope: h.snapshot_scope,
            projectRevision: h.project_revision,
            compositionId: assignment.case.composition,
            time: sample.sample.time,
            target: h.target,
            renderTarget: h.render_target,
            antiAliasing: h.aa,
            shadowsEnabled: true,
          },
        });
        samples.push({
          sample: sample.sample,
          reference_plan: { path: local(planPath), sha256: plan.sha256 },
          reference_resources: local(join(directory, "frame-resources")),
        });
      }
      const settings = {
        resources: {
          visualization: "beauty",
          locale: "en-US",
          layouts: {},
          surface: {
            revision: 1,
            maxTextureDimension: 4096,
            memoryBudgetMb: 512,
            renderScale: scale,
          },
          maximumRasterDimension: 8192,
          maximumRasterPixels: 67108864,
        },
        selectedLayerId: null,
        shadowMapSize: 1024,
      };
      const request = join(output, "requests", `${entry.id}.json`);
      await writeAtomicJson(request, {
        settings,
        frames,
        plugins: (assignment.case.plugins ?? []).map((p) => join(root, p, "plugin.toml")),
        rasterProvider: prepared.rasterProvider,
      });
      jobs.push({
        project: assignment.projectPath,
        request,
        out: join(output, "frames", entry.id),
      });
      expected.push({ id: entry.id, assignment, samples });
    }
    assert.equal(
      expected.reduce((sum, c) => sum + c.samples.length, 0),
      manifest.captured_samples,
    );
  } finally {
    await runtime.close();
  }
  await reader.stable();
  const batch = join(output, "batch.json");
  await writeAtomicJson(batch, jobs);
  return {
    batch,
    jobs,
    expected,
    reference: task.plan_reference_manifest,
    referenceSource,
    assignments,
    reader,
  };
}
