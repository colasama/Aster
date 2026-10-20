import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureResourceRequestOracle } from "./native-resource-request-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditResourceRequests(context, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const path = join(context.output, "resource-request-oracle.json");
  const coverage = await captureResourceRequestOracle(context.root, path, context.env);
  assert(coverage.cases >= 340 && coverage.samples >= 23591 && coverage.operations > 0);
  const file = await reader.bytes(local(path));
  const oracle = JSON.parse(file.bytes);
  const steps = [];
  for (const control of [
    null,
    "child-text-rate",
    "child-svg-density",
    "preparation-order",
    "media-time",
    "target-size",
    "stale-source",
  ]) {
    let input = path;
    if (control) {
      const value = { sources: structuredClone(oracle.sources), cases: [] };
      if (control === "stale-source") value.sources[0].sha256 = "0".repeat(64);
      else {
        const choose = (op) =>
          control === "child-text-rate"
            ? op.kind === "raster" &&
              op.request.kind === "text" &&
              op.request.instanceId.startsWith("surface:")
            : control === "child-svg-density"
              ? op.kind === "raster" &&
                op.request.kind === "svg" &&
                op.request.instanceId.startsWith("surface:")
              : control === "media-time"
                ? op.kind === "media"
                : op.kind === "target";
        const source = oracle.cases.find((c) =>
          c.samples.some((s) => s.expected.operations.some(choose)),
        );
        assert(source, control);
        const sample = structuredClone(
          source.samples.find((s) => s.expected.operations.some(choose)),
        );
        const operations = sample.expected.operations;
        const op = operations.find(choose);
        if (control === "child-text-rate") op.request.frameRate += 1;
        else if (control === "child-svg-density") op.request.width += 1;
        else if (control === "media-time") op.localTime += 0.01;
        else if (control === "target-size") op.target.width += 1;
        else {
          assert(operations.length > 1);
          operations.reverse();
        }
        value.cases = [{ ...source, samples: [sample] }];
      }
      input = join(context.output, `resource-request-${control}.json`);
      await writeAtomicJson(input, value);
      await reader.bytes(local(input));
    }
    const step = await execute(
      {
        id: `native-resource-request-${control ?? "parity"}`,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-media-native",
          "--test",
          "resource_request_oracle",
          "native_project_resource_requests_match_ts",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      { ...context, env: { ...context.env, ASTER_RESOURCE_REQUEST_ORACLE: input } },
    );
    steps.push(step);
    assert(!step.error && !step.signal);
    assert.equal(step.exit_code, control ? 101 : 0);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(
      control
        ? /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log)
        : /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log),
    );
  }
  return {
    status: "passed",
    scope: "native-ordered-project-resource-requests",
    gpu_allocation_observed: false,
    ...coverage,
    oracle: { path: local(path), sha256: file.sha256 },
    steps,
    checked_files: await reader.stable(),
  };
}
