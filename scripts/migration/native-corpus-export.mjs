import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { captureAssignments } from "../parity/provenance.mjs";
import { compareExportAudio } from "./encoded-audio-compare.mjs";
import { compareEncodedFrames } from "./encoded-quality-frames.mjs";
import { encodedStructuralAlternatives } from "./encoded-structural-policy.mjs";
import { exportReferenceSamples, scoreExportSamples } from "./export-reference-samples.mjs";
import { runCorpusExports } from "./native-corpus-runs.mjs";
import { captureStructuralWitness } from "./native-structural-witness.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

export function corpusExportAssignment(input, composition) {
  assert(!input.unavailable, input.unavailable);
  assert.equal(composition.id, input.case.composition);
  const start = Math.min(...input.case.frames),
    end = Math.max(...input.case.frames) + 1;
  assert(
    end <=
      Math.ceil(
        (composition.duration * composition.frameRate.numerator) /
          composition.frameRate.denominator,
      ),
  );
  return {
    ...input,
    benchmark: {
      id: `${input.case.id}-corpus-export`,
      mode: "full-mp4",
      run: 1,
      warmupFrames: 10,
      requireAudio:
        input.case.project === "env:ASTER_PERF_PROJECT" ||
        input.case.features?.includes("layer:audio") === true,
      startFrame: start,
      endFrameExclusive: end,
      frameRate: composition.frameRate,
    },
  };
}

/** Export whole addressed segments and compare their declared frames to authenticated references. */
export async function runNativeCorpusExport(context, ids = ["minimal-golden"], dependencies = {}) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = { status: "failed", native_export_acceptance: false, cases: [] };
  try {
    if (dependencies.kind) report.kind = dependencies.kind;
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const inputs = context.referenceInputs ?? new PixelInputs(context);
    if (context.referenceInputs) {
      assert.equal(resolve(inputs.context.root), resolve(root));
      await inputs.verifyStable();
    } else await inputs.loadReferenceCatalog();
    assert(ids.length && new Set(ids).size === ids.length);
    const selected = ids.map((id) => inputs.corpus.cases.find((item) => item.id === id));
    assert(selected.every(Boolean), "Unknown export corpus case");
    report.corpus = {
      path: "tests/parity/corpus.json",
      sha256: await hashFile(join(root, "tests/parity/corpus.json")),
    };
    const assignments = await captureAssignments(root, selected, context.env);
    const jobs = [],
      references = [];
    for (const assignment of assignments) {
      const first = await inputs.reference(assignment.case, assignment.case.frames[0]);
      const composition = await inputs.projectComposition(assignment.case, first.capture);
      const job = corpusExportAssignment(assignment, composition);
      const directory = join(output, assignment.case.id);
      await mkdir(directory);
      references.push(await exportReferenceSamples(inputs, job, composition, directory));
      jobs.push(job);
    }
    report.assignments = jobs;
    report.execution = await (dependencies.runCorpusExports ?? runCorpusExports)(
      { ...context, source: report.source },
      jobs,
    );
    const binary = resolve(root, report.execution.native_binary);
    for (const [index, job] of jobs.entries()) {
      const reference = references[index],
        directory = join(output, job.case.id);
      const entry = {
        id: job.case.id,
        status: "failed",
        comparisons: [],
        references: reference.evidence,
        frames: job.case.frames,
        frame_count: job.benchmark.endFrameExclusive - job.benchmark.startFrame,
        outputs: {},
        self_review: "required-separately",
      };
      report.cases.push(entry);
      for (const [arm, renderer] of [
        ["native", "rust"],
        ["ts", "ts"],
      ]) {
        const exportedCase = report.execution.arms[renderer].raw.cases[index];
        const exported = exportedCase.output;
        entry.outputs[arm] = {
          path: local(exported.outputPath),
          sha256: exported.ffprobe.sha256,
          probe: exported.ffprobe.result,
          audiovisual: report.execution.arms[renderer].audiovisual[index],
        };
        const result = await compareEncodedFrames(
          { ...context, output: directory },
          {
            ...reference,
            name: arm,
            binary,
            path: exported.outputPath,
            ...job.case.size,
            frameCount: entry.frame_count,
          },
        );
        entry.outputs[arm].decoded = result.decoded;
        entry.outputs[arm].reference_domain = result.reference_domain;
        entry.comparisons.push(...result.comparisons);
      }
      const exports = Object.fromEntries(
        Object.entries(entry.outputs).map(([arm, value]) => [
          arm,
          { ...value, path: resolve(root, value.path) },
        ]),
      );
      entry.audio = await compareExportAudio(context, exports);
      entry.quality = await scoreExportSamples(
        { ...context, output: directory },
        reference.samples,
        exports,
      );
      entry.absolute_pixels_passed = entry.comparisons
        .filter((frame) => frame.name === "native")
        .every((frame) => frame.passed);
      if (
        inputs.ledger.owner_overrides?.layered_structural_policy?.approved &&
        entry.comparisons.some(
          (frame) =>
            frame.name === "native" &&
            !frame.passed &&
            encodedStructuralAlternatives({ ...frame, profile: { name: "yuv" } })?.length,
        )
      ) {
        entry.structural_witness = await (
          dependencies.captureStructuralWitness ?? captureStructuralWitness
        )(
          { ...context, source: report.source, output: join(directory, "structural-witness") },
          job,
          entry,
          inputs,
          binary,
          report.execution,
        );
      }
      entry.status =
        entry.absolute_pixels_passed && entry.quality.passed && entry.audio.passed
          ? "awaiting-self-review"
          : "failed";
    }
    report.reference_binding = inputs.referenceBinding();
    report.checked_files = await inputs.verifyStable();
    assert.deepEqual(await captureAssignments(root, selected, context.env), assignments);
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    report.status = "measured";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { out: { type: "string" }, case: { type: "string", multiple: true } },
  });
  assert(values.out);
  const report = await runNativeCorpusExport(
    { root: process.cwd(), output: resolve(values.out), env: process.env, print: console.log },
    values.case,
  );
  console.log(
    JSON.stringify({
      status: report.status,
      error: report.error,
      cases: report.cases.map(({ id, status }) => ({ id, status })),
    }),
  );
  process.exitCode = report.status === "measured" ? 0 : 1;
}
