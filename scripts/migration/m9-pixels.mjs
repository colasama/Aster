import assert from "node:assert/strict";
import { dirname, join, relative, resolve } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { M0Evidence } from "./m0-evidence.mjs";

/** Authenticate existing comparisons without rerendering or replacing their original identities. */
export async function auditM9Pixels(root, gate, plans, projectCorpus, env = process.env) {
  const reader = new M0Evidence(root);
  assert.deepEqual(gate.project_corpus, projectCorpus);
  assert.deepEqual(await reader.json(projectCorpus.path, projectCorpus.sha256), plans);
  assert.equal(plans.kind, "native-project-corpus");
  assert.equal(plans.status, "passed");
  assert.equal(plans.full_coverage, true);
  assert.equal(gate.status, "passed");
  assert.equal(gate.scope, "full");
  assert.equal(gate.full_coverage, true);
  assert.equal(gate.inputs_unchanged, true);
  assert.equal(gate.source_unchanged, true);
  const local = (path) => relative(root, resolve(path)).replaceAll("\\", "/");
  const manifest = await reader.json(plans.candidates.path, plans.candidates.sha256);
  assert.equal(manifest.kind, "native-project-candidate");
  const inputs = new PixelInputs({ root, env });
  const entries = await inputs.load(join(root, plans.candidates.path), "full", null);
  const addresses = (group) => group.map((entry) => [entry.case_id, entry.frame]);
  assert.equal(gate.required_count, inputs.requiredCount);
  assert.deepEqual(addresses(gate.frames), addresses(entries));
  assert.deepEqual(addresses(gate.comparisons), addresses(entries));
  assert.deepEqual(
    gate.evidence,
    gate.comparisons.map((record) => record.evidence),
  );
  const binary = join(
    root,
    "target/release",
    `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
  );
  await reader.bytes(local(binary), plans.binaries[0].sha256);
  await reader.bytes(plans.binaries[0].path, plans.binaries[0].sha256);
  let reviewed = 0;
  for (const [index, entry] of entries.entries()) {
    const frame = gate.frames[index],
      record = gate.comparisons[index];
    assert.equal(frame.status, "passed");
    assert.equal(frame.profile, entry.profile);
    assert.deepEqual(frame.evidence, record.evidence);
    const evidence = record.evidence;
    const raw = await reader.json(evidence.report, evidence.report_sha256);
    assert.deepEqual(raw.comparison, record.comparison);
    assert.equal(raw.comparison.passed, true);
    const prepared = await inputs.prepare(entry);
    const destination = dirname(resolve(root, evidence.report));
    const output = dirname(dirname(destination));
    const name = `${entry.case_id}-${entry.frame}`;
    assert.equal(destination, join(output, "frames", name));
    const contextPath = join(output, "contexts", `${name}.json`);
    assert.deepEqual(await reader.json(local(contextPath)), prepared.context);
    const command = [
      binary,
      "compare",
      "--reference",
      prepared.reference.path,
      "--candidate",
      entry.path,
      "--tolerance",
      entry.profile,
      "--context",
      contextPath,
      "--out",
      destination,
    ];
    assertM9PixelCommand(frame.step, command, `pixel-${name}`);
    assert.equal(resolve(root, frame.step.log), join(output, `pixel-${name}.log`));
    const log = (await reader.bytes(frame.step.log)).bytes.toString("utf8");
    assert(
      log.startsWith(`Command: ${JSON.stringify(command)}\n`),
      "Comparator command log differs",
    );
    validateReport(raw, prepared, frame.step, inputs);
    const review = await reviewStatus(inputs, entry, raw);
    assert.equal(review.status, "passed");
    assert.equal(frame.self_review_required, review.self_review_required);
    if (review.self_review_required) {
      assert.deepEqual(frame.self_review, review.self_review);
      reviewed++;
    }
    const candidate = await reader.image(local(entry.path), entry.png_sha256);
    assert.equal(candidate.rgba_sha256, raw.comparison.candidate_rgba_sha256);
    assert.equal(candidate.width, entry.item.size.width);
    assert.equal(candidate.height, entry.item.size.height);
    for (const [key, filename, scale] of [
      ["heatmap", "heatmap.png", 1],
      ["contact_sheet", "contact-sheet.png", 2],
    ]) {
      assert.equal(resolve(root, evidence[key]), join(destination, filename));
      const image = await reader.image(evidence[key], evidence[`${key}_sha256`]);
      assert.equal(image.width, entry.item.size.width * scale);
      assert.equal(image.height, entry.item.size.height * scale);
    }
  }
  assert.deepEqual(gate.reference_binding, inputs.referenceBinding());
  const inputFiles = await inputs.verifyStable();
  return {
    status: "passed",
    frames: entries.length,
    reviewed,
    input_files: inputFiles,
    evidence_files: await reader.stable(),
    project_corpus: projectCorpus,
  };
}

export function assertM9PixelCommand(step, command, id) {
  assert.equal(step.id, id);
  assert.equal(step.status, "passed");
  assert.equal(step.exit_code, 0);
  assert(!step.error && !step.signal);
  assert.deepEqual(step.command, command, "Original comparator command differs");
}
