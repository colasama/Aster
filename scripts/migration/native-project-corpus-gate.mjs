import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { captureAssignments } from "../parity/provenance.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditProjectCorpusCheckpoint } from "./native-project-corpus-checkpoint.mjs";
import { prepareProjectCorpusInputs } from "./native-project-corpus-inputs.mjs";
import { ProjectPlanComparison } from "./native-project-plan-comparison.mjs";
import { prepareNativeProjectRuntime } from "./native-project-runtime.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Evaluate authored projects; the TS oracle is read only by the subsequent plan comparator. */
export async function runNativeProjectCorpusGate(context, execute = runStep) {
  if (context.projectCorpusResume) return auditProjectCorpusCheckpoint(context);
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = {
    id: "G2",
    status: "failed",
    kind: "native-project-corpus",
    cases: [],
    full_coverage: false,
  };
  let comparator;
  try {
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const prepared = await prepareNativeProjectRuntime(
      { ...context, output: join(output, "runtime") },
      execute,
    );
    report.build = prepared.build;
    report.execution = prepared.execution.snapshot;
    report.binaries = prepared.binaries;
    const inputs = await prepareProjectCorpusInputs(context, prepared);
    report.reference = inputs.reference;
    report.reference_source = inputs.referenceSource;
    report.required_cases = inputs.expected.length;
    report.required_samples = inputs.expected.reduce((sum, item) => sum + item.samples.length, 0);
    const reader = new M0Evidence(root),
      frames = [];
    comparator = new ProjectPlanComparison(context, reader, prepared.binary, execute);
    for (const [index, expected] of inputs.expected.entries()) {
      const job = inputs.jobs[index];
      const entry = { id: expected.id, status: "failed", samples: [] };
      report.cases.push(entry);
      entry.render = await execute(
        {
          id: `render-${expected.id}`,
          file: prepared.binary,
          args: [
            "render-project",
            "--project",
            job.project,
            "--request",
            job.request,
            "--out",
            job.out,
            "--ffmpeg",
            join(root, "build/ffmpeg/ffmpeg.exe"),
            "--ffprobe",
            join(root, "build/ffmpeg/ffprobe.exe"),
            "--dxcompiler",
            join(root, "node_modules/electron/dist/dxcompiler.dll"),
            "--layer-cache-bytes",
            "0",
            "--effect-pipeline-entries",
            "0",
            "--capture-output-bytes",
            "17179869184",
          ],
          timeout_ms: 1_800_000,
        },
        context,
      );
      assert.equal(entry.render.status, "passed", `Native render failed: ${expected.id}`);
      const receiptPath = local(join(job.out, "report.json"));
      const receipt = await reader.json(receiptPath);
      entry.receipt = { path: receiptPath, sha256: await hashFile(join(root, receiptPath)) };
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.kind, "native-project-render");
      assert.equal(receipt.raster_mode, "live");
      assert.equal(receipt.request_sha256, await hashFile(job.request));
      assert.equal(receipt.project.authored_sha256, expected.assignment.inputs.project_sha256);
      assert.equal(receipt.frames.length, expected.samples.length);
      for (const [sampleIndex, sample] of expected.samples.entries()) {
        const frame = receipt.frames[sampleIndex],
          directory = join(job.out, String(sampleIndex));
        assert.equal(frame.index, sampleIndex);
        assert.equal(frame.width, expected.assignment.case.size.width);
        assert.equal(frame.height, expected.assignment.case.size.height);
        await reader.bytes(local(join(directory, "plan.fpln")), frame.plan_sha256);
        await reader.bytes(sample.reference_plan.path, sample.reference_plan.sha256);
        const png = await reader.image(local(join(directory, "candidate.png")), frame.png_sha256);
        assert.equal(png.rgba_sha256, frame.rgba_sha256);
        entry.samples.push(
          await comparator.compare(expected, sample, sampleIndex, frame, directory, job, receipt),
        );
        if (sample.sample.kind === "declared")
          frames.push({
            case_id: expected.id,
            frame: sample.sample.frame,
            path: relative(output, join(directory, "candidate.png")).replaceAll("\\", "/"),
            png_sha256: frame.png_sha256,
          });
      }
      entry.status = entry.samples.every((sample) => sample.equal) ? "passed" : "failed";
      await writeAtomicJson(join(output, "report.json"), report);
      context.print?.(`${entry.id}: ${entry.status}, ${entry.samples.length} plans`);
      assert.equal(entry.status, "passed", `Native plan parity failed: ${entry.id}`);
    }
    const manifest = join(output, "candidates.json");
    await writeAtomicJson(manifest, {
      schema_version: 1,
      kind: "native-project-candidate",
      frames,
    });
    report.candidates = { path: local(manifest), sha256: await hashFile(manifest) };
    await inputs.reader.stable();
    report.checked_files = await reader.stable();
    assert.deepEqual(
      await captureAssignments(
        root,
        inputs.assignments.map((item) => item.case),
        context.env,
        { planReferences: true },
      ),
      inputs.assignments,
    );
    await prepared.assertUnchanged();
    report.source_after = await sourceProvenance(root);
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    report.source_unchanged = true;
    report.full_coverage =
      report.cases.length === inputs.expected.length &&
      report.cases.every(
        (item, index) => item.samples.length === inputs.expected[index].samples.length,
      );
    report.status =
      report.full_coverage && report.cases.every((item) => item.status === "passed")
        ? "passed"
        : "failed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await comparator?.close();
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
