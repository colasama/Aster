import { resolve } from "node:path";
import { freezePreviewBaseline } from "./performance/preview-baseline.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--report" || !args[1])
  throw new Error(
    "Usage: node scripts/preview-performance-baseline.mjs --report <fresh-preview-report.json>",
  );
const result = await freezePreviewBaseline(resolve(import.meta.dirname, ".."), args[1]);
console.log(JSON.stringify(result, null, 2));
