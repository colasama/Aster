import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import electron from "electron";
import { build, preview } from "vite";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

assert.equal(process.argv.length, 3, "Expected one output directory");
const root = process.cwd();
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const web = join(output, "web");
const entry = "tests/parity/material-textures/index.html";
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
    url: `http://127.0.0.1:${server.httpServer.address().port}/${entry}`,
  });
  const result = await runStep(
    {
      id: "electron",
      file: electron,
      args: ["scripts/migration/encoded-texture-electron.mjs"],
      timeout_ms: 120_000,
      env: { ASTER_ENCODED_GPU_CONFIG: config },
    },
    { root, output, env: process.env },
  );
  assert.equal(result.status, "passed", `Encoded texture GPU process failed: ${result.log}`);
} finally {
  if (server) await new Promise((resolveClose) => server.httpServer.close(resolveClose));
}
