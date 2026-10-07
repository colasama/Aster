import assert from "node:assert/strict";
import { posix, relative, toNamespacedPath } from "node:path";
import { sha256, validSha } from "./m0-evidence.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";

async function auditComparison(reader, frame, ledger, verdict) {
  const raw = await reader.json(frame.evidence);
  assert.deepEqual(raw.comparison, frame.comparison);
  assert.equal(raw.context.case_id, frame.case_id);
  assert.equal(raw.comparison.profile.name, "gpu");
  assert.equal(raw.comparison.passed, verdict === "accepted");
  if (verdict === "accepted") assert(raw.comparison.checks.every((check) => check.passed));
  for (const side of ["reference", "candidate"]) {
    const path = relative(
      toNamespacedPath(reader.root),
      toNamespacedPath(raw[side].path),
    ).replaceAll("\\", "/");
    const pixels = await reader.image(path, raw[side].png_sha256);
    assert.equal(pixels.rgba_sha256, raw.comparison[`${side}_rgba_sha256`]);
    assert.equal(pixels.width, raw.comparison.width);
    assert.equal(pixels.height, raw.comparison.height);
  }
  const review = ledger.self_reviews.find(
    (r) =>
      r.case_id === frame.case_id &&
      r.frame === frame.frame &&
      r.profile === "gpu" &&
      r.verdict === verdict &&
      r.reference_rgba_sha256 === raw.comparison.reference_rgba_sha256 &&
      r.candidate_rgba_sha256 === raw.comparison.candidate_rgba_sha256,
  );
  assert(review, `Review absent: ${frame.case_id}`);
  for (const name of ["report", "contact_sheet", "heatmap"])
    await reader.bytes(review.evidence[name], validSha(review.evidence[`${name}_sha256`]));
  for (const name of ["contact-sheet.png", "heatmap.png"])
    await reader.bytes(`${posix.dirname(frame.evidence)}/${name}`);
}

async function auditCache(reader, native, report) {
  const cache = native.native_layer_cache;
  const expected = new Map(
    native.frames.map((f) => [`${f.case_id}-${f.frame}`, f.receipt.rgba_sha256]),
  );
  for (const frame of native.native_surface_frames.frames)
    expected.set(frame.case_id, frame.receipt.rgba_sha256);
  const modes = ["default", "dxc"].flatMap((compiler) =>
    ["uncached", "cached", "unbounded"].map((mode) => `${compiler}-${mode}`),
  );
  assert.deepEqual(
    cache.batches.map((b) => b.id).sort(),
    modes.map((mode) => `layer-cache-${mode}`).sort(),
  );
  const seen = new Set(),
    counts = new Map();
  let hits = 0,
    bounded = 0,
    saved = 0;
  for (const batch of cache.batches) {
    validateCurrentStep(batch, report.started_at);
    const mode = batch.id.replace("layer-cache-", "");
    const log = (await reader.bytes(batch.log)).bytes.toString("utf8");
    const receipts = log
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map((line) => JSON.parse(line));
    const frames = cache.frames.filter((frame) => frame.mode === mode);
    assert.equal(receipts.length, frames.length);
    const cached = mode.endsWith("-cached"),
      unbounded = mode.endsWith("-unbounded");
    for (const [index, frame] of frames.entries()) {
      const key = `${frame.id}:${mode}:${frame.phase}`;
      assert(!seen.has(key));
      seen.add(key);
      counts.set(frame.id, (counts.get(frame.id) ?? 0) + 1);
      assert.equal(frame.phase, cached ? (index % 2 ? "repeated" : "first") : "disabled");
      const receipt = receipts[index];
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.native_gpu_execution, true);
      assert.equal(receipt.frame_index, index);
      assert.equal(receipt.renderer_reused, index > 0);
      assert.deepEqual(receipt.layer_cache, frame.cache);
      assert.deepEqual(receipt.effect_regions, frame.regions);
      const pixels = await reader.image(frame.path, frame.png_sha256);
      assert.equal(pixels.rgba_sha256, validSha(expected.get(frame.id)));
      assert.equal(pixels.rgba_sha256, frame.rgba_sha256);
      assert.equal(pixels.rgba_sha256, receipt.rgba_sha256);
      assert(frame.cache.resident_bytes <= 67108864);
      if (!cached) {
        assert.equal(frame.cache.allocations, 0);
        assert.equal(frame.cache.resident_bytes, 0);
      }
      if (unbounded) {
        assert.equal(frame.regions.bounded_passes, 0);
        assert.equal(frame.regions.drawn_pixels, frame.regions.full_pixels);
      } else if (!cached) {
        bounded += frame.regions.bounded_passes;
        saved += frame.regions.full_pixels - frame.regions.drawn_pixels;
      }
    }
    if (cached) hits += receipts.at(-1).layer_cache.hits;
  }
  assert.equal(counts.size, expected.size);
  for (const id of expected.keys()) assert.equal(counts.get(id), 4);
  assert.equal(hits, cache.hits);
  assert.equal(bounded, cache.bounded_passes);
  assert.equal(saved, cache.saved_pixels);
  return { exact: seen.size, hits, bounded_passes: bounded, saved_pixels: saved };
}

export async function auditM4Supplements(reader, native, report, ledger) {
  const surface = native.native_surface_frames;
  const expectedSurface = ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
    ["selectionIsolation", "vectorMotionBlur"].flatMap((mode) =>
      ["ready", "skipped"].map((status) => `native-surface-frame-${mode}-${aa}-${status}`),
    ),
  );
  assert.deepEqual(
    surface.frames.map((f) => f.case_id),
    expectedSurface,
  );
  validateCurrentStep(surface.batch, report.started_at);
  const log = (await reader.bytes(surface.batch.log)).bytes.toString("utf8");
  const receipts = log
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{"schema_version":'))
    .map((line) => JSON.parse(line));
  assert.equal(receipts.length, 16);
  const frozen = ledger.reference_baseline.native_surface_frame;
  const manifest = await reader.json(frozen.path, frozen.sha256);
  assert.equal(manifest.independent_ts_devices_exact, true);
  for (const file of manifest.files)
    await reader.bytes(`tests/parity/native-surface-frame/${file.path}`, file.sha256);
  for (const [index, frame] of surface.frames.entries()) {
    assert.deepEqual(receipts[index], frame.receipt);
    assert.equal(frame.receipt.plan_sha256, manifest.frames[index].plan_sha256);
    assert.equal(
      frame.comparison.reference_rgba_sha256,
      manifest.frames[index].reference_rgba_sha256,
    );
    assert.equal(frame.comparison.candidate_rgba_sha256, frame.receipt.rgba_sha256);
    await auditComparison(reader, frame, ledger, "accepted");
  }
  const post = native.native_surface_post;
  validateCurrentStep(post.gpu, report.started_at);
  const postPinned = ledger.reference_baseline.native_surface_post;
  const postManifest = await reader.json(postPinned.path, postPinned.sha256);
  assert.deepEqual(post.frames.map((f) => f.case_id).sort(), [
    "native-surface-selectionIsolation",
    "native-surface-vectorMotionBlur",
  ]);
  for (const frame of post.frames) {
    validateCurrentStep(frame.step, report.started_at);
    const input = postManifest.cases.find((c) => `native-surface-${c.id}` === frame.case_id);
    assert(input);
    await reader.bytes(`tests/parity/native-surface-post/${input.plan}`, input.plan_sha256);
    const reference = await reader.bytes(input.reference, input.reference_sha256);
    assert.equal(reference.sha256, frame.comparison.reference_rgba_sha256);
    await auditComparison(reader, frame, ledger, "accepted");
  }
  const auxiliary = native.native_auxiliary_primary;
  validateCurrentStep(auxiliary.gpu, report.started_at);
  const auxiliaryPinned = ledger.reference_baseline.native_auxiliary_primary;
  const auxiliaryManifest = await reader.json(auxiliaryPinned.path, auxiliaryPinned.sha256);
  for (const file of auxiliaryManifest.files)
    await reader.bytes(`tests/parity/native-auxiliary-primary/${file.path}`, file.sha256);
  assert.deepEqual(
    auxiliary.cases.map((c) => c.case_id),
    ["basic", "tier0", "tier1", "tier2", "no-motion", "cleared"],
  );
  for (const item of auxiliary.cases) {
    const bytes = (await reader.bytes(item.evidence)).bytes;
    const input = auxiliaryManifest.cases.find((c) => c.id === item.case_id);
    assert(input);
    const reference = (await reader.bytes(input.reference, input.reference_sha256)).bytes;
    assert.deepEqual(bytes, reference.subarray(0, bytes.length));
    assert.deepEqual(
      item.targets.map((t) => t.name),
      ["normal", "objectId", "materialId", "worldPosition", "motionVector"],
    );
    let offset = 0;
    for (const target of item.targets) {
      assert.equal(target.exact, true);
      const hash = sha256(bytes.subarray(offset, offset + target.bytes));
      offset += target.bytes;
      assert.equal(hash, validSha(target.reference_sha256));
      assert.equal(hash, target.candidate_sha256);
    }
    assert.equal(offset, bytes.length);
  }
  const ssaa = native.native_ssaa_effect_evaluation;
  validateCurrentStep(ssaa.gpu, report.started_at);
  assert.deepEqual(
    ssaa.frames.map((f) => f.case_id),
    ["blur-ssaa2x", "glow-ssaa2x", "blur-ssaa4x", "glow-ssaa4x"].map(
      (id) => `ssaa-reduction-${id}`,
    ),
  );
  for (const frame of ssaa.frames) {
    validateCurrentStep(frame.step, report.started_at, true, 1);
    await auditComparison(reader, frame, ledger, "rejected");
  }
  return {
    surface_frames: 16,
    surface_post: 2,
    primary_attachments: 30,
    cache: await auditCache(reader, native, report),
    ssaa_strategy: "rejected; production remains full resolution",
  };
}
