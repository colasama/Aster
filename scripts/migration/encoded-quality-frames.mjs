import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { decodeExportFrames } from "./encoded-frame-reader.mjs";
import { prepareEncodedReferences } from "./encoded-reference-domain.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Compare every decoded frame with its own reference and both adjacent reference identities. */
export async function compareEncodedFrames(context, options) {
  const { root, output } = context;
  const { name, width, height, references } = options;
  assert(/^[a-z][a-z0-9-]*$/.test(name));
  assert(references.length > 0);
  const frameCount = options.frameCount ?? references.length;
  const originalSamples = options.samples ?? references.map((path, frame) => ({ frame, path }));
  const prepared = await prepareEncodedReferences(context, {
    name,
    width,
    height,
    samples: originalSamples.map((sample) => ({
      ...sample,
      context: sample.context ?? {
        case_id: options.caseId,
        isolated: options.isolated === true,
        background: options.isolated === true ? [0, 0, 0, 255] : null,
        sequence: {
          frame: sample.frame,
          first_frame: 0,
          last_frame: references.length - 1,
          previous: sample.frame > 0 ? references[sample.frame - 1] : null,
          next: sample.frame + 1 < references.length ? references[sample.frame + 1] : null,
        },
      },
    })),
  });
  const samples = prepared.samples;
  const selected = new Map(samples.map((sample) => [sample.frame, sample]));
  assert.equal(selected.size, samples.length, "Duplicate export sample");
  assert(
    samples.every(({ frame }) => Number.isSafeInteger(frame) && frame >= 0 && frame < frameCount),
  );
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const comparisons = [];
  const decoded = await decodeExportFrames(
    {
      ffmpeg: join(root, "build/ffmpeg/ffmpeg.exe"),
      path: options.path,
      width,
      height,
      frameCount,
    },
    async (pixels, index) => {
      const sample = selected.get(index);
      if (!sample) return;
      const candidate = join(output, `${name}-${index}.png`);
      await writeFile(candidate, encodeRgbaPng(width, height, pixels), { flag: "wx" });
      const contextPath = join(output, `${name}-${index}.context.json`);
      const structural = sample.context;
      await writeAtomicJson(contextPath, structural);
      const destination = join(output, `${name}-${index}`);
      const step = await runStep(
        {
          id: `${name}-${index}`,
          file: options.binary,
          args: [
            "compare",
            "--reference",
            sample.path,
            "--candidate",
            candidate,
            "--tolerance",
            "yuv",
            "--context",
            contextPath,
            "--out",
            destination,
          ],
        },
        context,
      );
      const path = join(destination, "report.json");
      const report = JSON.parse(await readFile(path, "utf8"));
      const result = report.comparison;
      assert.equal(report.reference.png_sha256, await hashFile(sample.path));
      assert.equal(report.candidate.png_sha256, await hashFile(candidate));
      assert.equal(result.profile.name, "yuv");
      assert.equal(result.width, width);
      assert.equal(result.height, height);
      assert.equal(report.context.case_id, structural.case_id);
      assert.equal(report.context.g5_uniform_reference, true);
      assert.equal(result.isolated, structural.isolated);
      if (structural.sequence) {
        assert.equal(result.sequence.frame, structural.sequence.frame);
        assert.equal(result.sequence.first_frame, structural.sequence.first_frame);
        assert.equal(result.sequence.last_frame, structural.sequence.last_frame);
        assert(result.checks.some((check) => check.id === "frame_identity"));
      } else assert.equal(result.sequence, null);
      assert(!structural.isolated || result.checks.some((check) => check.id === "ink_bounds"));
      for (const neighbor of ["previous", "next"]) {
        assert.equal(
          report[neighbor]?.png_sha256 ?? null,
          structural.sequence?.[neighbor] ? await hashFile(structural.sequence[neighbor]) : null,
        );
      }
      assert.equal(
        result.passed,
        result.checks.every((check) => check.passed),
      );
      assert.equal(step.exit_code, result.passed ? 0 : 1);
      comparisons.push({
        name,
        index,
        report: local(path),
        report_sha256: await hashFile(path),
        context: { path: local(contextPath), sha256: await hashFile(contextPath) },
        step,
        passed: result.passed,
        metrics: result.metrics,
        structural: result.structural,
        registration: result.registration,
        sequence: result.sequence,
        checks: result.checks,
        isolated: result.isolated,
      });
    },
  );
  assert.equal(comparisons.length, samples.length, "Missing decoded export samples");
  return { decoded, comparisons, reference_domain: prepared.report };
}
