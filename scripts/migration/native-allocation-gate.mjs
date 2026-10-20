import assert from "node:assert/strict";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";

/** Device allocation controls complement plan parity without claiming final frame coverage. */
export async function auditNativeAllocations(context, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const steps = [];
  for (const name of [
    "native_project_allocations_are_real_reused_and_budgeted",
    "native_project_output_allocations_preserve_rendered_pixels",
    "auxiliary_primary_supplied_gpu_outputs_and_controls",
    "native_surface_cache_admits_atomically_reuses_and_retires_targets",
  ]) {
    const step = await execute(
      {
        id: `allocation-${name}`,
        file: "cargo",
        args: ["test", "-p", "aster-renderer", name, "--", "--ignored"],
      },
      context,
    );
    steps.push(step);
    assert.equal(step.status, "passed");
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(/test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log));
  }
  return {
    status: "passed",
    scope: "real-device-target-and-generator-allocation-controls",
    pixel_parity_acceptance: false,
    steps,
    checked_files: await reader.stable(),
  };
}
