import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureProjectMediaOracle } from "./native-project-media-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Project storage admission authenticates portable and bundle bytes without rewriting sources. */
export async function auditProjectMedia(context, projects, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const path = join(context.output, "project-media-oracle.json");
  const coverage = await captureProjectMediaOracle(context.root, path, projects);
  const input = await reader.bytes(local(path));
  const oracle = JSON.parse(input.bytes);
  const steps = [];
  for (const control of [null, "wrong-media-hash", "stale-source"]) {
    let oraclePath = path;
    if (control) {
      const invalid = structuredClone(oracle);
      if (control === "wrong-media-hash") invalid.cases[0].entries[0].sha256 = "0".repeat(64);
      else invalid.sources[0].sha256 = "0".repeat(64);
      oraclePath = join(context.output, `project-media-${control}.json`);
      await writeAtomicJson(oraclePath, invalid);
      await reader.bytes(local(oraclePath));
    }
    const step = await execute(
      {
        id: `native-project-media-${control ?? "parity"}`,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-project",
          "--test",
          "media_source_oracle",
          "project_media_bytes_match_ts_oracle",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      { ...context, env: { ...context.env, ASTER_PROJECT_MEDIA_ORACLE: oraclePath } },
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
    scope: "native-project-media-byte-admission",
    ...coverage,
    oracle: local(path),
    oracle_sha256: input.sha256,
    steps,
    checked_files: await reader.stable(),
  };
}
