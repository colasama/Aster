import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { capturePathOracle } from "./native-path-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditNativePaths(context, projectInputs, execute = runStep) {
  const output = join(context.output, "paths");
  const coverage = await capturePathOracle(context.root, output, projectInputs);
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const oracle = JSON.parse((await reader.bytes(coverage.output)).bytes);
  for (const input of oracle.cases)
    assert.equal((await reader.bytes(input.path)).sha256, input.sha256);
  const steps = [];
  async function check(id, path, accepted) {
    const step = await execute(
      {
        id,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-eval",
          "--test",
          "path_oracle",
          "native_paths_match_ts",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      { ...context, env: { ...context.env, ASTER_PATH_ORACLE: path } },
    );
    steps.push(step);
    assert(!step.error && !step.signal);
    assert.equal(step.status, accepted ? "passed" : "failed");
    assert.equal(step.exit_code, accepted ? 0 : 101);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(
      accepted
        ? /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log)
        : /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log),
    );
  }
  await check("native-path-parity", join(context.root, coverage.output), true);
  const wrong = structuredClone(oracle);
  let corrupted = false;
  for (let i = 0; i < wrong.cases.length; i++) {
    const item = JSON.parse((await reader.bytes(wrong.cases[i].path)).bytes);
    const sample = item.samples.find((s) => s.geometry.fill.length || s.geometry.stroke.length);
    if (!sample) continue;
    const points = sample.geometry.fill.length ? sample.geometry.fill : sample.geometry.stroke;
    points[0][0] += 100;
    const path = join(output, "wrong-vertex-case.json");
    await writeAtomicJson(path, item);
    wrong.cases[i] = { path: local(path), sha256: (await reader.bytes(local(path))).sha256 };
    corrupted = true;
    break;
  }
  assert(corrupted, "Path negative control requires a triangle");
  const wrongPath = join(output, "wrong-vertex-oracle.json");
  await writeAtomicJson(wrongPath, wrong);
  await reader.bytes(local(wrongPath));
  await check("native-path-reject-wrong-vertex", wrongPath, false);
  const stale = structuredClone(oracle);
  stale.sources[0].sha256 = "0".repeat(64);
  const stalePath = join(output, "stale-source-oracle.json");
  await writeAtomicJson(stalePath, stale);
  await reader.bytes(local(stalePath));
  await check("native-path-reject-stale-source", stalePath, false);
  return {
    status: "passed",
    scope: "path-morph-flatten-triangulate-trim-stroke-components",
    whole_project_plan_parity: false,
    ...coverage,
    steps,
    checked_files: await reader.stable(),
  };
}
