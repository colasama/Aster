import assert from "node:assert/strict";
import { dirname, relative, resolve, toNamespacedPath } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import {
  auditDiagnosticGrants,
  diagnosticStructuralInputs,
} from "./diagnostic-structural-inputs.mjs";
import {
  assertEncodedStructuralAuthorization,
  encodedStructuralPolicy,
} from "./encoded-structural-policy.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditNv12Case } from "./native-nv12-case.mjs";

/** Diagnostic witnesses are bound to production capture inputs, not the corpus replay manifest. */
export async function auditDiagnosticStructuralWitness(root, entry, execution, ledger) {
  const reader = new M0Evidence(root);
  const policy = assertEncodedStructuralAuthorization(ledger);
  await reader.bytes(policy.proposal.path, policy.proposal.sha256);
  assert.equal(execution.status, "diagnostic");
  assert.equal(execution.production_route, true);
  assert.equal(execution.source_unchanged, true);
  assert.equal(execution.source.source_sha256, execution.source_after.source_sha256);
  assert.deepEqual(entry.structural_witness, execution.structural_witness);
  const witness = await reader.json(entry.structural_witness.path, entry.structural_witness.sha256);
  assert.equal(witness.kind, encodedStructuralPolicy);
  assert.equal(witness.input_kind, "production-diagnostic");
  assert.equal(witness.case_id, entry.id);
  assert.equal(witness.source_unchanged, true);
  assert.equal(witness.execution_sha256, execution.source.execution_sha256);
  assert.deepEqual(witness.binary, execution.binary);
  assert.deepEqual(witness.capture, execution.input);
  await reader.bytes(witness.binary.path, witness.binary.sha256);
  const { assignment, frames } = await diagnosticStructuralInputs(
    reader,
    execution,
    entry.id.replace("native-encoded-", ""),
  );
  assert.deepEqual(witness.assignment, assignment);
  assert.deepEqual(
    witness.frames.map((f) => f.frame),
    assignment.case.frames,
  );
  assert.deepEqual(entry.frames, assignment.case.frames);
  await auditDiagnosticGrants(reader, witness.authorizations, frames[0].job);
  const conversion = await reader.json(witness.conversion.path, witness.conversion.sha256);
  assert.deepEqual(conversion.binary, witness.binary);
  for (const step of conversion.steps.filter((s) => s.command[1] === "render-plan")) {
    const index = step.command.indexOf("--media-authorizations");
    assert(index > 0);
    assert.equal(resolve(step.command[index + 1]), resolve(root, witness.authorizations.path));
  }
  const nv12 = await auditNv12Case(root, conversion, assignment, ledger);
  const local = (path) =>
    relative(toNamespacedPath(root), toNamespacedPath(resolve(path))).replaceAll("\\", "/");
  const catalog = await reader.json("tests/parity/tolerances.json");
  const catalogHash = (await reader.bytes("tests/parity/tolerances.json")).sha256;
  const inputs = {
    context: { root },
    ledger,
    catalog,
    catalogHash,
    bytes: (path) => reader.bytes(local(path)),
  };
  const results = [];
  for (const stages of witness.frames) {
    const frame = stages.frame;
    const encoded = entry.comparisons.find((f) => f.name === "native" && f.index === frame);
    assert.deepEqual(stages.encoded, { path: encoded.report, sha256: encoded.report_sha256 });
    const encodedRaw = await reader.json(encoded.report, encoded.report_sha256);
    const rendered = conversion.frames.find((f) => f.frame === frame);
    const reviews = [];
    let numeric = nv12.frames[frame].numeric_passed;
    for (const stage of ["rgb", "preencode"]) {
      const saved = stages[stage];
      const raw = await reader.json(saved.report.path, saved.report.sha256);
      const profile = stage === "rgb" ? "gpu" : "yuv";
      const reference =
        stage === "rgb"
          ? frames[frame].reference
          : {
              path: local(encodedRaw.reference.path),
              sha256: encodedRaw.reference.png_sha256,
            };
      const candidatePath =
        stage === "rgb"
          ? rendered.png.path
          : `${dirname(rendered.nv12.path).replaceAll("\\", "/")}/native.png`;
      assert.equal(local(raw.reference.path), reference.path);
      assert.equal(local(raw.candidate.path), candidatePath);
      const referenceImage = await reader.image(reference.path, reference.sha256);
      const candidateImage = await reader.image(candidatePath, raw.candidate.png_sha256);
      assert.equal(raw.comparison.candidate_rgba_sha256, candidateImage.rgba_sha256);
      const context =
        stage === "preencode"
          ? encodedRaw.context
          : {
              case_id: entry.id,
              isolated: true,
              background: [0, 0, 0, 0],
              sequence: {
                frame,
                first_frame: 0,
                last_frame: 2,
                previous: frame ? resolve(root, frames[frame - 1].reference.path) : null,
                next: frame < 2 ? resolve(root, frames[frame + 1].reference.path) : null,
              },
            };
      const neighbors = {};
      for (const [name, index] of [
        ["previous", frame - 1],
        ["next", frame + 1],
      ]) {
        const expected =
          stage === "preencode"
            ? encodedRaw[name]
            : index >= 0 && index < 3
              ? {
                  path: resolve(root, frames[index].reference.path),
                  png_sha256: frames[index].reference.sha256,
                }
              : null;
        neighbors[name] = expected;
        if (expected) {
          assert.equal(local(raw[name].path), local(expected.path));
          await reader.image(local(expected.path), expected.png_sha256);
        }
      }
      validateReport(
        raw,
        {
          entry: { profile, item: assignment.case, png_sha256: candidateImage.png_sha256 },
          reference: {
            png_sha256: referenceImage.png_sha256,
            meta: { rgba_sha256: referenceImage.rgba_sha256 },
          },
          context,
          neighbors,
        },
        saved.step,
        inputs,
      );
      assert.equal(saved.step.command[0], resolve(root, witness.binary.path));
      numeric &&= raw.comparison.passed;
      reviews.push(
        raw.comparison.passed
          ? await reviewStatus(inputs, { case_id: entry.id, frame, profile }, raw)
          : { status: "failed" },
      );
    }
    const converted = nv12.frames[frame];
    const reviewed = [...reviews, converted.review].every((r) => r.status === "passed");
    results.push({
      frame,
      numeric_passed: numeric,
      reviewed,
      status: !numeric ? "failed" : reviewed ? "passed" : "awaiting-self-review",
      rgb_review: reviews[0],
      nv12_review: converted.review,
      preencode_review: reviews[1],
    });
  }
  await reader.stable();
  return { witness: entry.structural_witness, frames: results };
}
