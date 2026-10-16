import assert from "node:assert/strict";
import { posix } from "node:path";
import { auditCaptureSet, capturedCaseSet } from "./m0-captures.mjs";
import { evidencePath, stableSource, validSha } from "./m0-evidence.mjs";

/** Owner-authorized oracle correction is separate from numerical tolerance acceptance. */
export function materialRepairSelection(ledger, definitions) {
  const kind = "material-ready-first-frame-reference-repair-v1";
  const selected = definitions.filter((repair) => repair.kind === kind);
  if (!selected.length) return null;
  const policy = ledger.owner_overrides?.material_reference_policy;
  assert.equal(policy?.kind, kind, "Material reference correction lacks its policy");
  assert.equal(policy.approved, true, "Material reference correction lacks owner approval");
  assert.equal(policy.preserve_originals, true);
  assert.equal(policy.other_quality_limits_unchanged, true);
  const allowed = [
    "scene-lighting-directional/0",
    "scene-lighting-point/0",
    "scene-lighting-spot/0",
  ];
  assert.deepEqual(policy.allowed_frames, allowed, "Material correction scope changed");
  assert.deepEqual(
    selected.map((repair) => `${repair.case_id}/${repair.frame}`).sort(),
    allowed,
    "Material correction must replace exactly the three approved first frames",
  );
  assert(selected.every((repair) => repair.frame === 0));
  for (const field of [
    "directory",
    "candidate_manifest",
    "candidate_manifest_sha256",
    "capture_report",
    "capture_report_sha256",
    "renderer_source_sha256",
  ])
    assert(selected.every((repair) => repair[field] === selected[0][field]));
  assert.equal(selected[0].candidate_manifest, `${selected[0].directory}/manifest.json`);
  return { policy, selected };
}

/** A scoped candidate remains diagnostic: it can only supply the three explicit repair addresses. */
export async function auditMaterialReferenceRepairs(
  reader,
  ledger,
  corpus,
  references,
  definitions,
) {
  const selection = materialRepairSelection(ledger, definitions);
  const results = new Map();
  if (!selection) return results;
  const { policy, selected } = selection;
  const proposal = await reader.json(
    evidencePath(policy.proposal.path),
    validSha(policy.proposal.sha256),
  );
  assert.equal(proposal.kind, policy.kind);
  assert.deepEqual(
    proposal.affected.map((item) => `${item.case_id}/${item.frame}`).sort(),
    policy.allowed_frames,
  );
  const first = selected[0];
  const manifestFile = await reader.bytes(
    evidencePath(first.candidate_manifest),
    validSha(first.candidate_manifest_sha256),
  );
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const report = await reader.json(
    evidencePath(first.capture_report),
    validSha(first.capture_report_sha256),
  );
  const ids = selected.map((repair) => repair.case_id).sort();
  const subset = { ...corpus, cases: corpus.cases.filter((item) => ids.includes(item.id)) };
  assert.equal(subset.cases.length, 3);
  capturedCaseSet(report, subset);
  assert(report.cases.every((item) => item.status === "passed"));
  assert.equal(report.capture_mode, "candidate");
  assert.equal(report.candidate.manifest, first.candidate_manifest);
  assert.equal(report.candidate.manifest_sha256, manifestFile.sha256);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.kind, "ts-candidate");
  assert.equal(manifest.source_verified, true);
  assert.equal(manifest.scope, "diagnostic");
  assert.equal(report.candidate.scope, "diagnostic");
  assert.deepEqual(manifest.selected_cases.toSorted(), ids);
  assert.equal(manifest.required_case_count, corpus.cases.length);
  assert.equal(
    manifest.required_frame_count,
    corpus.cases.reduce((sum, item) => sum + item.frames.length, 0),
  );
  assert.equal(manifest.corpus_sha256, (await reader.bytes("tests/parity/corpus.json")).sha256);
  assert.equal(manifest.source.renderer_source_sha256, validSha(first.renderer_source_sha256));
  stableSource(manifest.source, manifest.source_after, "renderer_source_sha256");
  assert.deepEqual(manifest.source, report.source);
  assert.deepEqual(manifest.source_after, report.source_after);
  assert.deepEqual(manifest.host, report.host);
  assert.equal(manifest.run_id, report.run_id);
  const snapshot = await auditCaptureSet(
    reader,
    subset,
    first.directory,
    first.renderer_source_sha256,
    manifest.cases,
    {
      run_id: manifest.run_id,
      source: manifest.source,
      host: manifest.host,
    },
  );
  assert.equal(snapshot.frames.size, 12);
  assert.equal(manifest.captured_frame_count, 12);
  assert.equal(report.candidate.case_count, 3);
  assert.equal(report.candidate.requested_frame_count, 12);
  assert.equal(report.candidate.captured_frame_count, 12);
  assert.equal(manifest.frames.length, 12);
  const seen = new Set();
  for (const entry of manifest.frames) {
    const key = `${entry.case_id}/${entry.frame}`,
      actual = snapshot.frames.get(key);
    assert(actual && !seen.has(key), "Missing or duplicate scoped capture frame");
    seen.add(key);
    assert.equal(`${first.directory}/${evidencePath(entry.path)}`, actual.path);
    assert.equal(`${first.directory}/${evidencePath(entry.meta_path)}`, actual.metaPath);
    for (const field of ["png_sha256", "meta_sha256", "rgba_sha256"])
      assert.equal(entry[field], actual[field]);
  }
  for (const repair of selected) {
    const key = `${repair.case_id}/0`,
      original = references.get(key),
      replacement = snapshot.frames.get(key);
    assert(original && replacement, "Material reference address is missing");
    const approved = proposal.affected.find((item) => item.case_id === repair.case_id);
    assert.equal(
      original.png_sha256,
      approved.original.sha256,
      "Original material reference changed",
    );
    assert.equal(
      replacement.rgba_sha256,
      approved.candidate_rgba_sha256,
      "Corrected frame differs from owner-reviewed pixels",
    );
    assert.equal(
      original.case_sha256,
      replacement.case_sha256,
      "Material repair changed project inputs",
    );
    assert.notEqual(original.rgba_sha256, replacement.rgba_sha256);
    const item = subset.cases.find((item) => item.id === repair.case_id);
    assert.deepEqual(item.frames, [0, 15, 30, 59]);
    const originalDirectory = posix.dirname(posix.dirname(original.path));
    const capture = await reader.json(`${originalDirectory}/capture.json`);
    assert.equal(capture.source_verified, true);
    assert.equal(capture.case_id, repair.case_id);
    for (const frame of [15, 30, 59]) {
      const pinned = capture.frames.find((value) => value.frame === frame);
      assert(pinned, "Original later frame is missing");
      const image = await reader.image(
        `${originalDirectory}/${frame}/frame.png`,
        validSha(pinned.png_sha256),
      );
      assert.equal(
        image.rgba_sha256,
        snapshot.frames.get(`${repair.case_id}/${frame}`).rgba_sha256,
        "Material repair changed a later frame",
      );
    }
    // Preserve the original failed comparison and its agent verdict; owner authorization
    // changes the reference address, never the verdict on those different pixel inputs.
    const review = ledger.self_reviews?.findLast(
      (entry) => entry.evidence?.report === repair.approval_review,
    );
    assert.equal(review?.verdict, "rejected");
    assert.equal(review.residual_class, "structural");
    const delta = await reader.json(
      evidencePath(repair.approval_review),
      validSha(review.evidence.report_sha256),
    );
    assert.equal(delta.comparison.reference_rgba_sha256, original.rgba_sha256);
    assert.equal(delta.comparison.candidate_rgba_sha256, replacement.rgba_sha256);
    assert.equal(delta.comparison.passed, false);
    for (const name of ["contact_sheet", "heatmap"])
      await reader.bytes(
        evidencePath(review.evidence[name]),
        validSha(review.evidence[`${name}_sha256`]),
      );
    results.set(key, {
      replacement,
      evidence: {
        ...repair,
        run_id: manifest.run_id,
        candidate_manifest_sha256: manifestFile.sha256,
        path: replacement.path,
        reference_rgba_sha256: original.rgba_sha256,
        candidate_rgba_sha256: replacement.rgba_sha256,
        authorization: policy.proposal,
        original_comparison_verdict: "rejected",
      },
    });
  }
  return results;
}
