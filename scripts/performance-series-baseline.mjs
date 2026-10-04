import assert from "node:assert/strict";
import { resolve } from "node:path";
import { freezePerformanceSeries } from "./performance/performance-series.mjs";

const [throughputReportPath, previewReportPath, ...extra] = process.argv.slice(2);
assert(
  throughputReportPath && previewReportPath && extra.length === 0,
  "Usage: node scripts/performance-series-baseline.mjs <throughput-report> <preview-report>",
);
const result = await freezePerformanceSeries(resolve(import.meta.dirname, ".."), {
  throughputReportPath,
  previewReportPath,
});
console.log(JSON.stringify(result));
