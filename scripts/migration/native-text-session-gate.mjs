import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Production session requests must omit supported text; compare its actual GPU layer output. */
export async function runNativeTextSessionGate(context, observationsRoot, execute = runStep) {
  const report = {
    status: "failed",
    scope: "ordinary-outline-fill-production-v1",
    native_text_acceptance: false,
    samples: [],
    comparisons: [],
  };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const observations = await reader.json(local(join(observationsRoot, "ordinary/report.json")));
    const extended = await reader.json(local(join(observationsRoot, "extended/report.json")));
    assert.equal(observations.status, "passed");
    assert.equal(extended.status, "passed");
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pinned = ledger.milestones.find((m) => m.id === "M3").input_manifest;
    const manifest = await reader.json(pinned.path, pinned.sha256);
    const base = posix.dirname(pinned.path);
    const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
    const assignment = corpus.cases.find((c) => c.id === "scene-motion-blur");
    const captured = manifest.cases.find((c) => c.case_id === assignment.id);
    const capture = await reader.json(`${base}/${captured.path}`, captured.capture_sha256);
    assert.deepEqual(capture.inputs.case, assignment);
    const source = observations.cases.find((c) => c.id === assignment.id);
    const images = extended.cases.find((c) => c.id === assignment.id);
    const projectPath = assignment.project.endsWith(".json")
      ? assignment.project
      : `${assignment.project}/project.json`;
    const project = await reader.json(projectPath, source.project_sha256);
    assert.equal(source.project_sha256, capture.inputs.project_sha256);
    const composition = project.compositions.find((c) => c.id === assignment.composition);
    const records = [];
    assert.equal(source.samples.length, source.observations.length);
    assert.equal(images.observations.length, source.observations.length);
    for (const [index, entry] of source.observations.entries()) {
      const ordinary = await reader.json(
        local(join(observationsRoot, "ordinary", source.id, entry.path)),
        entry.sha256,
      );
      const extendedEntry = images.observations[index];
      const observed = await reader.json(
        local(join(observationsRoot, "extended", source.id, extendedEntry.path)),
        extendedEntry.sha256,
      );
      assert.deepEqual(ordinary.sample, source.samples[index]);
      assert.deepEqual(observed.sample, ordinary.sample);
      assert.equal(ordinary.sample.composition, composition.id);
      assert.equal(ordinary.sample.scale, 1);
      assert.equal(ordinary.records.length, 1);
      assert.equal(observed.records.length, 1);
      const record = observed.records[0];
      assert.equal(record.temporal, false);
      assert.equal(record.observation_neutral, true);
      assert.equal(record.rgba_sha256, ordinary.records[0].rgba_sha256);
      const image = await reader.image(
        local(join(observationsRoot, "extended", source.id, record.image.path)),
        record.image.sha256,
      );
      assert.equal(image.rgba_sha256, record.rgba_sha256);
      records.push({ record, image });
    }
    const input = join(context.output, "request.json"),
      output = join(context.output, "native");
    await writeAtomicJson(input, {
      project: resolve(context.root, projectPath),
      project_sha256: source.project_sha256,
      composition: composition.id,
      size: { width: composition.width, height: composition.height },
      locale: observations.host.segmentation_locale,
      samples: source.samples.map(({ time, scale }) => ({ time, scale })),
      output: resolve(output),
    });
    report.input = { path: local(input), sha256: await hashFile(input) };
    report.step = await execute(
      {
        id: "native-text-production-session",
        file: "cargo",
        args: [
          "test",
          "--release",
          "-p",
          "aster-render-project",
          "--test",
          "text_session_oracle",
          "--",
          "--ignored",
        ],
        env: { ASTER_TEXT_SESSION_INPUT: resolve(input) },
      },
      context,
    );
    assert.equal(report.step.status, "passed");
    const receipts = await reader.json(local(join(output, "receipts.json")));
    assert.equal(receipts.length, records.length);
    const binary = join(
      context.root,
      "target/release",
      process.platform === "win32" ? "aster-render-cli.exe" : "aster-render-cli",
    );
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    const comparePair = async (id, frame, width, height, reference, candidatePixels) => {
      const directory = join(context.output, `${id}-${frame}`);
      const ref = `${directory}-reference.png`,
        candidate = `${directory}-candidate.png`,
        ctx = `${directory}-context.json`;
      await writeFile(ref, encodeRgbaPng(width, height, reference), {
        flag: "wx",
      });
      await writeFile(candidate, encodeRgbaPng(width, height, candidatePixels), {
        flag: "wx",
      });
      await writeAtomicJson(ctx, {
        case_id: id,
        isolated: true,
        background: [0, 0, 0, 0],
      });
      const step = await execute(
        {
          id: `compare-${id}-${frame}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            ref,
            "--candidate",
            candidate,
            "--tolerance",
            "perceptual",
            "--context",
            ctx,
            "--out",
            directory,
          ],
        },
        context,
      );
      const comparison = (await reader.json(local(join(directory, "report.json")))).comparison;
      assert.equal(comparison.reference_rgba_sha256, sha256(reference));
      assert.equal(comparison.candidate_rgba_sha256, sha256(candidatePixels));
      const result = {
        case_id: id,
        frame,
        comparison,
        step,
        evidence: local(join(directory, "report.json")),
      };
      report.comparisons.push(result);
      return result;
    };
    const pairs = new Map();
    for (const [index, receipt] of receipts.entries()) {
      const { record, image } = records[index];
      assert.equal(receipt.retained_text_requests, 0);
      assert.equal(receipt.native_inputs, 1);
      assert.equal(receipt.stale_frame_rejected, true);
      assert.equal(receipt.source_sha256, source.project_sha256);
      assert.equal(receipt.routes.length, 1);
      assert(receipt.routes[0].frame);
      const request = receipt.routes[0].capability.request;
      assert.equal(request.composition, record.composition);
      assert.equal(request.layer, record.layer);
      assert.equal(request.source_time, record.local_time);
      assert.equal(request.resolution_scale, record.requested_scale);
      assert.equal(request.locale, observations.host.segmentation_locale);
      assert.deepEqual(receipt.sample, {
        time: source.samples[index].time,
        scale: source.samples[index].scale,
      });
      const pixels = await reader.bytes(local(join(output, `${index}.rgba`)), receipt.rgba_sha256);
      assert.equal(pixels.bytes.length, record.width * record.height * 4);
      const key = `${record.rgba_sha256}/${pixels.sha256}`;
      if (!pairs.has(key))
        pairs.set(
          key,
          await comparePair(
            "native-production-text-layer",
            pairs.size,
            record.width,
            record.height,
            image.pixels,
            pixels.bytes,
          ),
        );
      if (source.samples[index].scope === "declared-corpus") {
        const frame = assignment.frames[index];
        assert.equal(
          source.samples[index].time,
          frame / (composition.frameRate.numerator / composition.frameRate.denominator),
        );
        const frozen = capture.frames.find((f) => f.frame === frame);
        assert(frozen);
        const reference = await reader.image(
          `${base}/${assignment.id}/${frame}/frame.png`,
          frozen.png_sha256,
        );
        const current = await reader.bytes(
          local(join(output, `${index}.frame.rgba`)),
          receipt.frame_rgba_sha256,
        );
        assert.equal(current.bytes.length, reference.width * reference.height * 4);
        await comparePair(
          "native-production-text-frame",
          frame,
          reference.width,
          reference.height,
          reference.pixels,
          current.bytes,
        );
      }
      report.samples.push({
        index,
        sample: receipt.sample,
        route: receipt.routes[0],
        comparison: pairs.get(key).frame,
      });
    }
    assert.equal(
      report.comparisons.filter((c) => c.case_id === "native-production-text-frame").length,
      assignment.frames.length,
    );
    for (const result of report.comparisons) {
      assert(
        result.comparison.passed,
        `Native production text pixels rejected: ${result.evidence}`,
      );
      assert.equal(result.step.status, "passed");
      if (!result.comparison.metrics.exact)
        assert(
          ledger.self_reviews.some(
            (r) =>
              r.case_id === result.case_id &&
              r.frame === result.frame &&
              r.profile === "perceptual" &&
              r.verdict === "accepted" &&
              r.reference_rgba_sha256 === result.comparison.reference_rgba_sha256 &&
              r.candidate_rgba_sha256 === result.comparison.candidate_rgba_sha256,
          ),
          "Production text self-review missing",
        );
    }
    assert.equal(await hashFile(binary), report.binary.sha256);
    report.checked_files = await reader.stable();
    report.native_text_acceptance = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
