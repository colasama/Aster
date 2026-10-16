import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runExportObservation } from "./native-export-observation.mjs";

export function runNativeBenchmarkExport(context, options = {}) {
  return runExportObservation(context, { ...options, renderer: "rust" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      case: { type: "string", multiple: true },
      smoke: { type: "boolean" },
      run: { type: "string", default: "1" },
    },
  });
  assert(values.out, "--out is required");
  process.env.ASTER_PERF_PROJECT ??= "D:/code/SD04PV";
  const report = await runNativeBenchmarkExport(
    { root: process.cwd(), output: resolve(values.out), env: process.env, print: console.log },
    { cases: values.case, smoke: values.smoke, run: Number(values.run) },
  );
  console.log(JSON.stringify({ status: report.status, scope: report.scope, error: report.error }));
  process.exitCode = report.status === "passed" ? 0 : 1;
}
