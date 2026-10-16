import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import {
  assertEncodedStructuralAuthorization,
  encodedStructuralPolicy,
} from "./encoded-structural-policy.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureNv12Case, nv12CaseInputs } from "./native-nv12-case.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Capture independent RGB and conversion witnesses without modifying encoded comparison reports. */
export async function captureStructuralWitness(context, job, entry, inputs, binary) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const pin = async (path) => ({ path: local(path), sha256: await hashFile(path) });
  const policy = assertEncodedStructuralAuthorization(inputs.ledger);
  const reader = new M0Evidence(root);
  await reader.bytes(policy.proposal.path, policy.proposal.sha256);
  const source = await sourceProvenance(root);
  assert.equal(source.execution_sha256, context.source.execution_sha256);
  const inputManifest = inputs.ledger.milestones.find((m) => m.id === "M3").input_manifest;
  const manifest = await reader.json(inputManifest.path, inputManifest.sha256);
  const assignment = await nv12CaseInputs(
    reader,
    job.case,
    manifest.cases.find((c) => c.case_id === job.case.id),
    dirname(inputManifest.path).replaceAll("\\", "/"),
    manifest,
  );
  assert.deepEqual(
    (await reader.json(assignment.capture.path, assignment.capture.sha256)).inputs,
    job.inputs,
  );
  const conversionDirectory = join(output, "conversion");
  const conversion = await captureNv12Case(
    { ...context, output: conversionDirectory },
    assignment,
    binary,
  );
  const candidatePath = join(output, "rgb-candidate.json");
  await writeAtomicJson(candidatePath, {
    schema_version: 1,
    frames: conversion.frames.map((f) => ({
      case_id: job.case.id,
      frame: f.frame,
      path: relative(output, resolve(root, f.png.path)).replaceAll("\\", "/"),
      png_sha256: f.png.sha256,
    })),
  });
  const rgb = await runPixelGate(
    { ...context, output: join(output, "rgb") },
    { manifestPath: candidatePath, scope: "diagnostic" },
  );
  const rgbPath = join(output, "rgb.json");
  await writeAtomicJson(rgbPath, rgb);
  const report = {
    kind: encodedStructuralPolicy,
    case_id: job.case.id,
    execution_sha256: source.execution_sha256,
    binary: await pin(binary),
    assignment,
    input_manifest: inputManifest,
    reference_binding: inputs.referenceBinding(),
    conversion: await pin(join(conversionDirectory, "report.json")),
    rgb: await pin(rgbPath),
    rgb_manifest: await pin(candidatePath),
    preencode: [],
  };
  for (const frame of conversion.frames) {
    const encoded = entry.comparisons.find(
      (c) => c.name === "native" && c.index === frame.frame - job.benchmark.startFrame,
    );
    assert(encoded, "Missing encoded frame for structural witness");
    const original = await reader.json(encoded.report, encoded.report_sha256);
    const candidate = join(conversionDirectory, String(frame.frame), "native.png");
    const path = join(output, `preencode-${frame.frame}`),
      contextPath = join(output, `preencode-${frame.frame}.context.json`);
    await writeAtomicJson(contextPath, original.context);
    const step = await runStep(
      {
        id: `preencode-${frame.frame}`,
        file: binary,
        args: [
          "compare",
          "--reference",
          original.reference.path,
          "--candidate",
          candidate,
          "--tolerance",
          "yuv",
          "--context",
          contextPath,
          "--out",
          path,
        ],
      },
      context,
    );
    const measured = JSON.parse(await readFile(join(path, "report.json"), "utf8"));
    assert.equal(step.exit_code, measured.comparison.passed ? 0 : 1);
    report.preencode.push({
      frame: frame.frame,
      encoded: { path: encoded.report, sha256: encoded.report_sha256 },
      report: await pin(join(path, "report.json")),
      step,
    });
  }
  await reader.stable();
  await inputs.verifyStable();
  assert.equal(await hashFile(binary), report.binary.sha256);
  const after = await sourceProvenance(root);
  assert.equal(source.source_sha256, after.source_sha256);
  report.source_unchanged = true;
  await writeAtomicJson(join(output, "report.json"), report);
  return pin(join(output, "report.json"));
}
