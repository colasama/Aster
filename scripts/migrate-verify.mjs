import { resolve } from "node:path";
import { parseArguments, verifyMigration } from "./migration/verify.mjs";

try {
  const result = await verifyMigration({
    ...parseArguments(process.argv.slice(2)),
    root: resolve(import.meta.dirname, ".."),
    print: console.log,
  });
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
