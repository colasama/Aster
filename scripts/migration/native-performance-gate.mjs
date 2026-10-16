import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runNativePerformanceGate } from "./native-paired-performance.mjs";
import { runStep } from "./process.mjs";

export { runNativePerformanceGate };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      smoke: { type: "boolean" },
      case: { type: "string", multiple: true },
    },
  });
  assert(values.out, "--out is required");
  process.env.ASTER_PERF_PROJECT ??= "D:/code/SD04PV";
  const report = await runNativePerformanceGate(
    { root: process.cwd(), output: resolve(values.out), env: process.env, print: console.log },
    runStep,
    { smoke: values.smoke, cases: values.case },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      full_coverage: report.full_coverage,
      error: report.error,
    }),
  );
  process.exitCode =
    report.status === "passed" || (report.status === "incomplete" && report.execution_complete)
      ? 0
      : 1;
}
