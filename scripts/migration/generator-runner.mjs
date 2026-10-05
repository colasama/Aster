import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import electron from "electron";
import { build, preview } from "vite";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

assert(
  [3, 4].includes(process.argv.length),
  "Expected output directory and optional --reference-only",
);
assert(process.argv[3] === undefined || process.argv[3] === "--reference-only");
const root = process.cwd();
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const web = join(output, "web");
const entry = "tests/parity/generators-replay/index.html";
let server;
try {
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      outDir: web,
      emptyOutDir: false,
      rolldownOptions: { input: [resolve(entry)] },
    },
  });
  server = await preview({
    configFile: false,
    logLevel: "error",
    build: { outDir: web },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const config = join(output, "config.json");
  await writeAtomicJson(config, {
    output,
    root,
    referenceOnly: process.argv[3] === "--reference-only",
    url: `http://127.0.0.1:${server.httpServer.address().port}/${entry}`,
  });
  const result = await runStep(
    {
      id: "electron",
      file: electron,
      args: ["scripts/migration/generator-electron.mjs"],
      timeout_ms: 120_000,
      env: { ASTER_GENERATOR_GPU_CONFIG: config },
    },
    { root, output, env: process.env },
  );
  assert.equal(result.status, "passed", `Generator GPU process failed: ${result.log}`);
} finally {
  if (server) await new Promise((resolveClose) => server.httpServer.close(resolveClose));
}
