import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { validateFrameArtifacts } from "../parity/frame-artifacts.mjs";
import { encodeRgbaPng } from "../parity/png.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Qualify authored glyph output without granting production admission to rejected rasters. */
export async function runNativeProjectTextPixels(
  context,
  observationsRoot,
  binary = join(
    context.root,
    "target/release",
    process.platform === "win32" ? "aster-render-cli.exe" : "aster-render-cli",
  ),
  execute = runStep,
) {
  const report = {
    status: "failed",
    native_text_acceptance: false,
    frames: [],
    retained_requirements: [],
  };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pinned = ledger.milestones.find((m) => m.id === "M3").input_manifest;
    const manifest = await reader.json(pinned.path, pinned.sha256);
    const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
    const item = corpus.cases.find((c) => c.id === "layer-text");
    const base = posix.dirname(pinned.path);
    const entry = manifest.cases.find((c) => c.case_id === item.id);
    const capture = await reader.json(`${base}/${entry.path}`, entry.capture_sha256);
    assert.deepEqual(capture.inputs.case, item);
    const projectPath = item.project.endsWith(".json")
      ? item.project
      : `${item.project}/project.json`;
    const projectFile = await reader.bytes(projectPath);
    assert.equal(projectFile.sha256, capture.inputs.project_sha256);
    assert.deepEqual(capture.inputs.frames, item.frames);
    const project = JSON.parse(projectFile.bytes);
    const composition = project.compositions.find((c) => c.id === item.composition);
    assert.equal(composition.layers.length, 1);
    const layer = composition.layers[0];
    // A crop is an isolated raster only for this authenticated identity-transform fixture.
    assert.equal(layer.kind, "text");
    assert.deepEqual(layer.size, [280, 100]);
    assert.deepEqual(item.size, { width: 320, height: 180 });
    assert.equal(layer.effects.length, 0);
    for (const [name, values] of Object.entries({
      position: [160, 90, 0],
      anchor: [140, 50, 0],
      scale: [100, 100, 100],
      rotation: [0, 0, 0],
    })) {
      assert.deepEqual(
        layer.transform[name],
        values.map((value) => ({ mode: "static", value })),
      );
    }
    assert.deepEqual(layer.transform.opacity, { mode: "static", value: 100 });
    const observations = await reader.json(local(join(observationsRoot, "ordinary/report.json")));
    assert.equal(observations.status, "passed");
    const observed = observations.cases.find((c) => c.id === item.id);
    assert.equal(observed.project_sha256, projectFile.sha256);
    const rate = composition.frameRate.numerator / composition.frameRate.denominator;
    const jobs = [],
      records = [],
      artifactCache = new Map();
    for (const frame of item.frames) {
      const frozen = capture.frames.find((f) => f.frame === frame);
      const meta = await reader.json(`${base}/${item.id}/${frame}/meta.json`, frozen.meta_sha256);
      await validateFrameArtifacts(
        async (path) => (await reader.bytes(`${base}/${item.id}/${path}`)).bytes,
        meta,
        item,
        manifest.source,
        artifactCache,
      );
      const sampleIndex = observed.samples.findIndex(
        (s) =>
          s.scope === "declared-corpus" &&
          s.composition === composition.id &&
          s.time === frame / rate &&
          s.scale === 1,
      );
      assert(sampleIndex >= 0);
      const observation = observed.observations.find((o) => o.path === `${sampleIndex}.json`);
      assert(observation, `Missing ordinary text observation ${frame}`);
      const actual = await reader.json(
        local(join(observationsRoot, "ordinary", item.id, observation.path)),
        observation.sha256,
      );
      assert.deepEqual(actual.sample, observed.samples[sampleIndex]);
      assert.equal(actual.records.length, 1);
      const record = actual.records[0];
      assert.equal(record.composition, composition.id);
      assert.equal(record.layer, layer.id);
      assert.equal(record.local_time, frame / rate);
      assert.equal(record.temporal, false);
      assert.equal(record.observation_neutral, true);
      assert.deepEqual([record.width, record.height], layer.size);
      const plan = `${base}/${item.id}/${frame}/replay.fpln`;
      jobs.push({
        project: resolve(context.root, projectPath),
        project_sha256: projectFile.sha256,
        request: {
          composition: composition.id,
          layer: layer.id,
          source_time: frame / rate,
          resolution_scale: 1,
          maximum_dimension: 4096,
          locale: observations.host.segmentation_locale,
          bounds: null,
        },
        plan: resolve(context.root, plan),
        plan_sha256: (await reader.bytes(plan)).sha256,
        resources: resolve(context.root, `${base}/${item.id}/frame-resources`),
        output: resolve(context.output, `${frame}.rgba`),
      });
      const encoded = (await reader.bytes(plan)).bytes;
      const metadata = JSON.parse(encoded.subarray(32, 32 + encoded.readUInt32LE(8)));
      assert.equal(metadata.slices[0].media_pixels.length, 1);
      records.push({ ...record, frozen_pixels: metadata.slices[0].media_pixels[0].pixels });
    }
    const input = resolve(context.output, "requests.json"),
      output = resolve(context.output, "receipts.json");
    await writeAtomicJson(input, jobs);
    report.input = { path: local(input), sha256: await hashFile(input) };
    report.step = await execute(
      {
        id: "native-authored-text-pixels",
        file: "cargo",
        args: [
          "test",
          "--release",
          "-p",
          "aster-render-project",
          "--test",
          "text_pixels_oracle",
          "--",
          "--ignored",
        ],
        env: { ASTER_PROJECT_TEXT_PIXEL_INPUT: input, ASTER_PROJECT_TEXT_PIXEL_OUTPUT: output },
      },
      context,
    );
    assert.equal(report.step.status, "passed");
    const receipts = await reader.json(local(output));
    assert.equal(receipts.length, jobs.length);
    for (const [index, receipt] of receipts.entries()) {
      const frame = item.frames[index],
        job = jobs[index];
      assert.equal(receipt.project_sha256, projectFile.sha256);
      assert.equal(receipt.original_plan_sha256, job.plan_sha256);
      assert.deepEqual(receipt.request, job.request);

      assert.equal(receipt.removed_cpu_rasters, 1);
      assert.equal(receipt.retained_session_exact, true);
      assert.equal(
        receipt.retained_reason,
        "stroke coverage exceeds the isolated raster alpha limit",
      );
      assert(receipt.glyph_draws > 0 && receipt.atlas_bytes > 0);
      assert.deepEqual([receipt.width, receipt.height], [320, 180]);
      const candidate = await reader.bytes(local(job.output), receipt.native_rgba_sha256);
      const witness = await reader.bytes(
        local(job.output.replace(/\.rgba$/, ".reference.rgba")),
        receipt.reference_rgba_sha256,
      );
      const reference = await reader.image(`${base}/${item.id}/${frame}/frame.png`);
      assert.equal(
        witness.sha256,
        reference.rgba_sha256,
        "Supplied TS raster witness must be exact",
      );
      const crop = (bytes) =>
        Buffer.concat(
          Array.from({ length: 100 }, (_, y) =>
            bytes.subarray(((y + 40) * 320 + 20) * 4, ((y + 40) * 320 + 300) * 4),
          ),
        );
      const originalLayer = crop(witness.bytes),
        nativeLayer = crop(candidate.bytes);
      const resources = await reader.json(`${base}/${item.id}/${frame}/resources.json`);
      const rasterPackets = resources.filter((r) => r.hash === records[index].frozen_pixels);
      assert.equal(rasterPackets.length, 1);
      const raw = await reader.bytes(
        `${base}/${item.id}/frame-resources/${rasterPackets[0].hash}.bin`,
        receipt.layer_rgba_sha256,
      );
      assert.equal(raw.bytes.length, originalLayer.length);
      let witnessMaxError = 0;
      for (let pixel = 0; pixel < raw.bytes.length; pixel += 4) {
        assert.equal(originalLayer[pixel + 3], raw.bytes[pixel + 3], "Isolated crop changed alpha");
        for (let channel = 0; channel < 3; channel++) {
          const premultiplied = Math.round(
            (raw.bytes[pixel + channel] * raw.bytes[pixel + 3]) / 255,
          );
          witnessMaxError = Math.max(
            witnessMaxError,
            Math.abs(originalLayer[pixel + channel] - premultiplied),
          );
        }
      }
      assert(
        witnessMaxError <= 1,
        "Isolated witness changed beyond GPU premultiplication rounding",
      );

      for (const [scope, width, height, ref, current] of [
        ["frame", 320, 180, witness.bytes, candidate.bytes],
        ["raster", 280, 100, originalLayer, nativeLayer],
      ]) {
        const id = `native-project-text-${scope}`,
          destination = join(context.output, `${frame}-${scope}`);
        const refPath = `${destination}-reference.png`,
          candidatePath = `${destination}-candidate.png`,
          ctx = `${destination}.context.json`;
        await writeFile(refPath, encodeRgbaPng(width, height, ref), { flag: "wx" });
        await writeFile(candidatePath, encodeRgbaPng(width, height, current), { flag: "wx" });
        await writeAtomicJson(ctx, { case_id: id, isolated: true, background: [0, 0, 0, 0] });
        const step = await execute(
          {
            id: `compare-authored-${frame}-${scope}`,
            file: binary,
            args: [
              "compare",
              "--reference",
              refPath,
              "--candidate",
              candidatePath,
              "--tolerance",
              "perceptual",
              "--context",
              ctx,
              "--out",
              destination,
            ],
          },
          context,
        );
        const comparison = (await reader.json(local(join(destination, "report.json")))).comparison;
        assert.equal(comparison.reference_rgba_sha256, sha256(ref));
        assert.equal(comparison.candidate_rgba_sha256, sha256(current));
        assert.equal(step.exit_code, comparison.passed ? 0 : 1);
        const verdict = comparison.passed ? "accepted" : "rejected";
        report.frames.push({
          case_id: id,
          frame,
          comparison,
          verdict,
          evidence: local(join(destination, "report.json")),
          step,
          crop_witness_max_error: witnessMaxError,
          current_observation_rgba_sha256: records[index].rgba_sha256,
          frozen_raster_rgba_sha256: receipt.layer_rgba_sha256,
        });
        if (!comparison.passed)
          report.retained_requirements.push({
            composition: composition.id,
            layer: layer.id,
            frame,
            scope,
            failed_checks: comparison.checks.filter((c) => !c.passed).map((c) => c.id),
            reason:
              "Authored raster pixel qualification failed; production must retain TS text for this capability.",
          });
      }
    }
    for (const frame of report.frames) {
      assert(
        ledger.self_reviews.some(
          (r) =>
            r.case_id === frame.case_id &&
            r.frame === frame.frame &&
            r.profile === "perceptual" &&
            r.verdict === frame.verdict &&
            r.reference_rgba_sha256 === frame.comparison.reference_rgba_sha256 &&
            r.candidate_rgba_sha256 === frame.comparison.candidate_rgba_sha256,
        ),
        `Self-review missing: ${frame.case_id}/${frame.frame}/${frame.verdict}`,
      );
    }
    report.qualified = report.retained_requirements.length === 0;
    assert.equal(await hashFile(binary), report.binary.sha256);
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
