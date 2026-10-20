import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureExpressionOracle } from "./native-expression-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditNativeExpressions(context, projectInputs, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const path = join(context.output, "expression-oracle.json");
  const coverage = await captureExpressionOracle(context.root, path, projectInputs);
  const oracleFile = await reader.bytes(local(path));
  const oracle = JSON.parse(oracleFile.bytes);
  const steps = [];
  async function check(id, input, accepted) {
    const step = await execute(
      {
        id,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-eval",
          "--test",
          "expression_oracle",
          "expressions_match_current_ts_oracle",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      { ...context, env: { ...context.env, ASTER_EXPRESSION_ORACLE: input } },
    );
    steps.push(step);
    assert(!step.error && !step.signal, "Expression test process failed outside the comparison");
    assert.equal(step.status, accepted ? "passed" : "failed");
    assert.equal(step.exit_code, accepted ? 0 : 101);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(
      accepted
        ? /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log)
        : /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log),
    );
  }
  await check("native-expression-parity", path, true);
  for (const kind of ["wrong-value", "wrong-zero-sign", "stale-source"]) {
    const invalid = structuredClone(oracle);
    if (kind === "wrong-value") invalid.cases[0].value += 100;
    else if (kind === "wrong-zero-sign")
      invalid.cases.find((item) => item.expression === "round(-0.5)").negative_zero = false;
    else invalid.sources[0].sha256 = "0".repeat(64);
    const invalidPath = join(context.output, `expression-${kind}.json`);
    await writeAtomicJson(invalidPath, invalid);
    await reader.bytes(local(invalidPath));
    await check(`native-expression-reject-${kind}`, invalidPath, false);
  }
  return {
    status: "passed",
    scope: "bounded-expressions-and-layer-transform-components",
    whole_project_plan_parity: false,
    ...coverage,
    output: local(path),
    oracle_sha256: oracleFile.sha256,
    steps,
    checked_files: await reader.stable(),
  };
}
