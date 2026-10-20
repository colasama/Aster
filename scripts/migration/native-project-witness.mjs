import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertEncodedStructuralAuthorization,
  encodedStructuralPolicy,
} from "./encoded-structural-policy.mjs";
import { nv12PlaneComparison } from "./native-nv12-case.mjs";
import { runProjectWitnessPixels } from "./native-project-witness-pixels.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Observe the RGB and NV12 already submitted by this export; never replay another plan. */
export async function captureProjectStructuralWitness(
  context,
  job,
  entry,
  inputs,
  binary,
  execution,
) {
  assertEncodedStructuralAuthorization(inputs.ledger);
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const pin = async (path) => ({ path: local(path), sha256: await hashFile(path) });
  const json = async (path) => JSON.parse(await readFile(path, "utf8"));
  const captured = execution.arms.rust.raw.cases.find((value) => value.caseId === job.case.id);
  assert(captured);
  const binding = captured.receipt.witness;
  assert.equal(await hashFile(binding.path), binding.report_sha256);
  const witness = await json(binding.path);
  assert.deepEqual(witness, captured.witness);
  assert.equal(witness.output_sha256, await hashFile(captured.output.outputPath));
  assert.equal(witness.project_authored_sha256, job.inputs.project_sha256);
  const base = dirname(binding.path);
  const report = {
    kind: encodedStructuralPolicy,
    input_kind: "native-project-export",
    case_id: entry.id,
    execution_sha256: context.source.execution_sha256,
    binary: await pin(binary),
    ffmpeg: await pin(join(root, "build/ffmpeg/ffmpeg.exe")),
    export_witness: { path: local(binding.path), sha256: binding.report_sha256 },
    reference_binding: inputs.referenceBinding(),
    frames: [],
  };
  const manifest = join(base, "rgb-candidates.json");
  const frames = witness.frames.map((frame) => ({
    case_id: entry.id,
    frame: job.benchmark.startFrame + frame.index,
    path: `${frame.index}/candidate.png`,
    png_sha256: frame.rgb.png_sha256,
  }));
  assert.deepEqual(
    frames.map((frame) => frame.frame),
    job.case.frames.toSorted((a, b) => a - b),
  );
  await writeAtomicJson(manifest, {
    schema_version: 1,
    kind: "native-project-export-witness",
    frames,
  });
  report.rgb_manifest = await pin(manifest);
  const rgb = await runProjectWitnessPixels(
    { ...context, output: join(output, "rgb") },
    manifest,
    inputs,
    binary,
  );
  await writeAtomicJson(join(output, "rgb.json"), rgb);
  report.rgb = await pin(join(output, "rgb.json"));
  for (const frame of witness.frames) {
    const absolute = job.benchmark.startFrame + frame.index;
    const directory = join(output, String(absolute));
    await mkdir(directory);
    const native = join(base, String(frame.index), "input.nv12");
    assert.equal(await hashFile(native), frame.nv12_sha256);
    const conversion = join(directory, "reference.nv12");
    const stepContext = { ...context, output: directory };
    const steps = [];
    const convert = await runStep(
      {
        id: "convert",
        file: join(root, report.ffmpeg.path),
        args: [
          "-v",
          "error",
          "-i",
          join(base, String(frame.index), "candidate.png"),
          "-frames:v",
          "1",
          "-vf",
          "scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=nv12",
          "-f",
          "rawvideo",
          conversion,
        ],
      },
      stepContext,
    );
    steps.push(convert);
    assert.equal(convert.status, "passed");
    const planes = nv12PlaneComparison(
      await readFile(conversion),
      await readFile(native),
      job.case.size,
    );
    for (const [name, path] of [
      ["reference", conversion],
      ["native", native],
    ]) {
      const decode = await runStep(
        {
          id: `decode-${name}`,
          file: join(root, report.ffmpeg.path),
          args: [
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pixel_format",
            "nv12",
            "-video_size",
            `${job.case.size.width}x${job.case.size.height}`,
            "-i",
            path,
            "-frames:v",
            "1",
            "-vf",
            "scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba",
            join(directory, `${name}.png`),
          ],
        },
        stepContext,
      );
      steps.push(decode);
      assert.equal(decode.status, "passed");
    }
    const encoded = entry.comparisons.find(
      (value) => value.name === "native" && value.index === frame.index,
    );
    assert(encoded);
    const original = await json(resolve(root, encoded.report));
    assert.equal(await hashFile(resolve(root, encoded.report)), encoded.report_sha256);
    const contexts = {
      conversion: {
        case_id: `nv12-conversion-${entry.id}`,
        isolated: false,
        background: null,
        sequence: null,
        g5_uniform_reference: true,
      },
      preencode: original.context,
    };
    const results = {};
    for (const [stage, comparisonContext] of Object.entries(contexts)) {
      const contextPath = join(directory, `${stage}.json`);
      await writeAtomicJson(contextPath, comparisonContext);
      const compared = await runStep(
        {
          id: stage,
          file: binary,
          args: [
            "compare",
            "--reference",
            stage === "conversion" ? join(directory, "reference.png") : original.reference.path,
            "--candidate",
            join(directory, "native.png"),
            "--tolerance",
            "yuv",
            "--context",
            contextPath,
            "--out",
            join(directory, stage),
          ],
        },
        stepContext,
      );
      const path = join(directory, stage, "report.json"),
        measured = await json(path);
      assert.equal(compared.exit_code, measured.comparison.passed ? 0 : 1);
      assert.equal(compared.status, measured.comparison.passed ? "passed" : "failed");
      assert(!compared.error && !compared.signal);
      results[stage] = { report: await pin(path), step: compared };
    }
    report.frames.push({
      frame: absolute,
      index: frame.index,
      nv12: await pin(native),
      reference: await pin(conversion),
      planes,
      steps,
      encoded: { path: encoded.report, sha256: encoded.report_sha256 },
      ...results,
    });
  }
  assert.equal((await sourceProvenance(root)).source_sha256, context.source.source_sha256);
  report.source_unchanged = true;
  await writeAtomicJson(join(output, "report.json"), report);
  return pin(join(output, "report.json"));
}
