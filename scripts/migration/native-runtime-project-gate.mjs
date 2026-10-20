import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureRuntimeProjectOracle } from "./native-runtime-project-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Runtime upgrades precede native evaluation without changing persisted source documents. */
export async function auditRuntimeProjects(context, projects, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const path = join(context.output, "runtime-project-oracle.json");
  const coverage = await captureRuntimeProjectOracle(context.root, path, projects);
  const input = await reader.bytes(local(path));
  const oracle = JSON.parse(input.bytes);
  const steps = [];
  for (const control of [null, "wrong-anchor", "stale-source"]) {
    let oraclePath = path;
    if (control) {
      const invalid = structuredClone(oracle);
      if (control === "wrong-anchor")
        invalid.cases[0].expected.compositions[0].layers[0].transform.anchor[0].value += 100;
      else invalid.sources[0].sha256 = "0".repeat(64);
      oraclePath = join(context.output, `runtime-project-${control}.json`);
      await writeAtomicJson(oraclePath, invalid);
      await reader.bytes(local(oraclePath));
    }
    const step = await execute(
      {
        id: `native-runtime-project-${control ?? "parity"}`,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-project",
          "--test",
          "runtime_oracle",
          "runtime_upgrades_match_ts_oracle",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      { ...context, env: { ...context.env, ASTER_RUNTIME_PROJECT_ORACLE: oraclePath } },
    );
    steps.push(step);
    assert(!step.error && !step.signal);
    assert.equal(step.exit_code, control ? 101 : 0);
    assert.equal(step.status, control ? "failed" : "passed");
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(
      control
        ? /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log)
        : /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log),
    );
  }
  return {
    status: "passed",
    scope: "native-runtime-schema-upgrades",
    ...coverage,
    oracle: local(path),
    oracle_sha256: input.sha256,
    steps,
    checked_files: await reader.stable(),
  };
}
