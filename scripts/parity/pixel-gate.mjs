import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runStep } from "../migration/process.mjs";
import { writeAtomicJson } from "../migration/report.mjs";
import { PixelInputs } from "./pixel-inputs.mjs";
import { reviewStatus } from "./pixel-review.mjs";

function validateReport(report, prepared, result, inputs) {
  const { entry, reference, context, neighbors } = prepared;
  const comparison = report.comparison;
  assert.equal(report.schema_version, 1, "Unknown comparison report schema");
  assert.equal(comparison?.schema_version, 1, "Missing comparison metrics");
  assert.equal(
    comparison.profile?.name,
    entry.profile,
    "CLI compared a different tolerance profile",
  );
  assert.equal(
    comparison.profile.catalog_sha256,
    inputs.catalogHash,
    "CLI tolerance catalog is stale",
  );
  assert.equal(comparison.width, entry.item.size.width);
  assert.equal(comparison.height, entry.item.size.height);
  assert.equal(
    report.reference.png_sha256,
    reference.png_sha256,
    "CLI read a different reference PNG",
  );
  assert.equal(report.candidate.png_sha256, entry.png_sha256, "CLI read a different candidate PNG");
  assert.equal(
    comparison.reference_rgba_sha256,
    reference.meta.rgba_sha256,
    "Reference RGBA content differs from its capture metadata",
  );
  assert(
    /^[a-f0-9]{64}$/.test(comparison.candidate_rgba_sha256),
    "CLI candidate RGBA hash is absent",
  );
  assert(isDeepStrictEqual(report.context, context), "CLI used different structural context");
  for (const name of ["previous", "next"]) {
    assert.equal(
      report[name]?.png_sha256 ?? null,
      neighbors[name]?.png_sha256 ?? null,
      "CLI read a different sequence neighbor",
    );
  }
  assert.equal(comparison.self_review_required, entry.profile !== "exact");
  assert.equal(comparison.isolated, context.isolated);
  assert(
    Array.isArray(comparison.checks) &&
      comparison.checks.length > 0 &&
      comparison.checks.every((check) => typeof check.passed === "boolean"),
    "CLI check evidence is missing",
  );
  assert.equal(
    comparison.passed,
    comparison.checks.every((check) => check.passed),
    "CLI aggregate result contradicts its checks",
  );
  const profile = inputs.catalog.profiles?.[entry.profile];
  assert(profile, "Selected profile is absent from the current catalog");
  const expectedChecks = profile.exact ? ["exact_rgba"] : [];
  for (const [limit, check] of [
    ["max_abs_channel_error", "max_abs_channel_error"],
    ["mean_abs_error", "mean_abs_error"],
    ["min_psnr_db", "psnr"],
    ["min_ssim", "ssim"],
  ]) {
    if (profile[limit] !== undefined && profile[limit] !== null) expectedChecks.push(check);
  }
  if (profile.structural) {
    expectedChecks.push("error_clusters", "signed_bias", "alpha_coverage", "registration");
    if (context.isolated) expectedChecks.push("ink_bounds");
  }
  if (context.sequence) expectedChecks.push("frame_identity");
  assert.deepEqual(
    comparison.checks.map((check) => check.id).sort(),
    expectedChecks.sort(),
    "CLI check set is incomplete, duplicated, or unexpected",
  );
  if (entry.profile !== "exact") {
    assert(
      comparison.structural && comparison.registration,
      "Non-exact structural evidence is missing",
    );
    for (const id of ["error_clusters", "signed_bias", "alpha_coverage", "registration"]) {
      assert(
        comparison.checks.some((check) => check.id === id),
        `Missing structural check ${id}`,
      );
    }
    if (context.isolated)
      assert(
        comparison.structural.ink_bounds &&
          comparison.checks.some((check) => check.id === "ink_bounds"),
        "Isolated ink bounds evidence is missing",
      );
  }
  if (context.sequence)
    assert(
      comparison.sequence && comparison.checks.some((check) => check.id === "frame_identity"),
      "Sequence frame identity evidence is missing",
    );
  assert.equal(
    result.exit_code,
    comparison.passed ? 0 : 1,
    "CLI exit code contradicts its comparison report",
  );
  assert.equal(
    result.status,
    comparison.passed ? "passed" : "failed",
    "Comparison process failed independently of its metrics",
  );
  assert(!result.error && !result.signal, "Comparison process was interrupted or failed");
}

export async function runPixelGate(
  context,
  { manifestPath, scope = "full", profileOverride = null },
  execute = runStep,
) {
  const gate = {
    id: "G3",
    status: "failed",
    scope,
    full_coverage: false,
    frames: [],
    required_count: 0,
    comparisons: [],
    evidence: [],
  };
  const inputs = new PixelInputs(context);
  try {
    assert(
      manifestPath,
      "G3 requires a candidate manifest; comparison never regenerates references",
    );
    const entries = await inputs.load(resolve(context.root, manifestPath), scope, profileOverride);
    gate.required_count = inputs.requiredCount;
    gate.full_coverage = scope === "full";
    const output = context.output;
    await mkdir(join(output, "frames"), { recursive: true });
    await mkdir(join(output, "contexts"), { recursive: true });
    for (const entry of entries) {
      const frame = {
        case_id: entry.case_id,
        frame: entry.frame,
        profile: entry.profile,
        status: "failed",
      };
      gate.frames.push(frame);
      try {
        const prepared = await inputs.prepare(entry);
        const name = `${entry.case_id}-${entry.frame}`;
        const destination = join(output, "frames", name);
        const contextPath = join(output, "contexts", `${name}.json`);
        await writeAtomicJson(contextPath, prepared.context);
        const result = await execute(
          {
            id: `pixel-${name}`,
            file: join(
              context.root,
              "target",
              "release",
              `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
            ),
            args: [
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
            ],
            timeout_ms: 300_000,
          },
          context,
        );
        frame.step = result;
        const reportPath = join(destination, "report.json");
        const report = await inputs.json(reportPath);
        validateReport(report, prepared, result, inputs);
        const evidence = {
          report: relative(context.root, reportPath).replaceAll("\\", "/"),
          heatmap: relative(context.root, join(destination, "heatmap.png")).replaceAll("\\", "/"),
          contact_sheet: relative(context.root, join(destination, "contact-sheet.png")).replaceAll(
            "\\",
            "/",
          ),
        };
        // Artifact existence is part of comparison success, including intentionally rejected results.
        for (const name of ["report", "heatmap", "contact_sheet"]) {
          evidence[`${name}_sha256`] = (
            await inputs.bytes(resolve(context.root, evidence[name]))
          ).sha256;
        }
        gate.comparisons.push({
          case_id: entry.case_id,
          frame: entry.frame,
          comparison: report.comparison,
          evidence,
        });
        gate.evidence.push(evidence);
        frame.evidence = evidence;
        if (!report.comparison.passed) {
          frame.error = "Pixel metrics or structural checks failed";
          frame.self_review_required = entry.profile !== "exact";
        } else Object.assign(frame, await reviewStatus(inputs, entry, report));
      } catch (error) {
        frame.error = error.message;
      }
    }
    gate.verified_files = await inputs.verifyStable();
    gate.inputs_unchanged = true;
    gate.status = gate.frames.some((frame) => frame.status === "failed")
      ? "failed"
      : gate.frames.some((frame) => frame.status === "incomplete")
        ? "incomplete"
        : "passed";
  } catch (error) {
    gate.status = "failed";
    gate.error = error.message;
    gate.inputs_unchanged = false;
  }
  gate.required_count = inputs.requiredCount ?? 0;
  gate.reference_binding = inputs.referenceBinding();
  return gate;
}
