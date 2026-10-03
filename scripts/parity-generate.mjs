import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { writeAtomicJson } from "./migration/report.mjs";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check"))
  throw new Error("Only --check is supported");
const exampleRoot = join(root, "artifacts", "parity", "projects", "enchanted-love");
execFileSync(process.execPath, ["examples/projects/enchanted-love/build.mjs", exampleRoot], {
  cwd: root,
  windowsHide: true,
  stdio: "inherit",
});
const example = JSON.parse(await readFile(join(exampleRoot, "project.json"), "utf8"));
const shots = JSON.parse(await readFile(join(exampleRoot, "shots.json"), "utf8"));
process.env.ASTER_PERF_PROJECT ??= process.platform === "win32" ? "D:\\code\\SD04PV" : "";
let owner;
try {
  if (process.env.ASTER_PERF_PROJECT)
    owner = JSON.parse(
      await readFile(join(process.env.ASTER_PERF_PROJECT, "project.json"), "utf8"),
    );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!owner)
  console.warn("Owner project unavailable: retained frame addresses are not performance evidence");
const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: { ignored: ["**/artifacts/**"] } },
  appType: "custom",
});
try {
  const { buildGeneratedCases } = await server.ssrLoadModule("/tests/parity/generators/index.ts");
  const { assertCorpusCoverage } = await server.ssrLoadModule("/tests/parity/coverage.ts");
  const { exampleCases, ownerCases } = await server.ssrLoadModule(
    "/tests/parity/external-cases.ts",
  );
  const generated = buildGeneratedCases();
  assertCorpusCoverage(generated);
  const cases = [
    ...exampleCases(example, shots),
    ...ownerCases(owner),
    ...generated.map((value) => value.case),
  ];
  const corpus = { schemaVersion: 1, cases };
  const manifest = join(root, "tests", "parity", "corpus.json");
  if (check)
    assert.deepEqual(
      JSON.parse(await readFile(manifest, "utf8")),
      corpus,
      "Corpus manifest is stale; run pnpm parity:generate",
    );
  else {
    for (const value of generated) {
      const path = join(root, value.case.project);
      const previous = await readFile(path, "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (previous !== `${JSON.stringify(value.project, null, 2)}\n`)
        await writeAtomicJson(path, value.project);
    }
    await writeAtomicJson(manifest, corpus);
  }
  console.log(
    `Corpus ${check ? "checked" : "generated"}: ${cases.length} cases, ${cases.reduce((sum, value) => sum + value.frames.length, 0)} frame addresses`,
  );
} finally {
  await server.close();
}
