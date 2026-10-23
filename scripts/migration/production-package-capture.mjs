import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { app } from "electron";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

// Electron's filesystem reads the actual packaged archive without extracting or modifying it.
const archive = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
const report = { status: "failed", archive };
try {
  const originalFs = createRequire(import.meta.url)("original-fs"),
    digest = createHash("sha256");
  for await (const chunk of originalFs.createReadStream(archive)) digest.update(chunk);
  report.archive_sha256 = digest.digest("hex");
  const path = join(archive, "dist/renderer-boundary.json");
  report.boundary = JSON.parse(await readFile(path, "utf8"));
  assert.equal(report.boundary.schema_version, 1);
  assert.equal(report.boundary.reference, false);
  assert.deepEqual(report.boundary.retained_modules, []);
  assert(!(await readdir(archive)).includes("dist-reference"));
  report.boundary_sha256 = await hashFile(path);
  report.status = "passed";
} catch (error) {
  report.error = error.stack ?? String(error);
} finally {
  await writeAtomicJson(output, report);
  app.exit(report.status === "passed" ? 0 : 1);
}
