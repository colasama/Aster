import { resolve } from "node:path";
import { parseTsPixelArguments, verifyTsPixels } from "./migration/ts-pixels.mjs";

try {
  const result = await verifyTsPixels({
    ...parseTsPixelArguments(process.argv.slice(2)),
    root: resolve(import.meta.dirname, ".."),
    print: console.log,
  });
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
