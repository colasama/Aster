import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { projectPixelEntries } from "./native-project-pixel-inputs.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Native-only orchestration shares repair evidence while retaining the frozen pixel validators. */
export async function runProjectWitnessPixels(
  context,
  manifestPath,
  inputs,
  binary,
  execute = runStep,
) {
  const gate = {
    id: "G3",
    status: "failed",
    scope: "diagnostic",
    full_coverage: false,
    frames: [],
    comparisons: [],
    evidence: [],
  };
  try {
    const entries = await projectPixelEntries(context.root, manifestPath, inputs);
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
            file: binary,
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
        for (const name of ["report", "heatmap", "contact_sheet"])
          evidence[`${name}_sha256`] = (
            await inputs.bytes(resolve(context.root, evidence[name]))
          ).sha256;
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
    gate.error = error.message;
    gate.inputs_unchanged = false;
  }
  gate.required_count = inputs.requiredCount ?? 0;
  gate.reference_binding = inputs.referenceBinding();
  return gate;
}
