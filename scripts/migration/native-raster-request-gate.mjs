import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureRasterRequestOracle } from "./native-raster-request-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditRasterRequests(context, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const path = join(context.output, "raster-request-oracle.json");
  const coverage = await captureRasterRequestOracle(context.root, path, context.env);
  assert(coverage.cases > 0 && coverage.samples > 0 && coverage.requests > 0);
  const file = await reader.bytes(local(path));
  const oracle = JSON.parse(file.bytes);
  const steps = [];
  for (const control of [null, "wrong-text-time", "wrong-svg-extent", "stale-source"]) {
    let input = path;
    if (control) {
      const value = structuredClone(oracle);
      if (control === "stale-source") value.sources[0].sha256 = "0".repeat(64);
      else {
        const kind = control === "wrong-text-time" ? "text" : "svg";
        const item = value.cases.find((c) =>
          c.samples.some((s) => s.expected.some((r) => r.kind === kind)),
        );
        assert(item);
        const sample = item.samples.find((s) => s.expected.some((r) => r.kind === kind));
        const request = sample.expected.find((r) => r.kind === kind);
        if (kind === "text") request.sourceTime += 0.01;
        else request.width += 1;
        item.samples = [sample];
        value.cases = [item];
      }
      input = join(context.output, `raster-request-${control}.json`);
      await writeAtomicJson(input, value);
      await reader.bytes(local(input));
    }
    const step = await execute(
      {
        id: `native-raster-request-${control ?? "parity"}`,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-media-native",
          "--test",
          "raster_request_oracle",
          "native_retained_raster_requests_match_ts",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      { ...context, env: { ...context.env, ASTER_RASTER_REQUEST_ORACLE: input } },
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
    scope: "native-retained-raster-requests",
    fresh_raster_pixels_verified: false,
    ...coverage,
    oracle: { path: local(path), sha256: file.sha256 },
    steps,
    checked_files: await reader.stable(),
  };
}
