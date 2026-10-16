import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import electron from "electron";
import { build, preview } from "vite";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { sourceProvenance } from "./source.mjs";

assert.equal(process.argv.length, 3, "Expected independent capture output directory");
const root = process.cwd(),
  output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const entry = "tests/parity/native-media-frame/index.html",
  web = join(output, "web");
let server;
try {
  await build({
    configFile: false,
    logLevel: "error",
    build: { outDir: web, emptyOutDir: false, rolldownOptions: { input: [resolve(entry)] } },
  });
  server = await preview({
    configFile: false,
    logLevel: "error",
    build: { outDir: web },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const config = join(output, "config.json");
  await writeAtomicJson(config, {
    root,
    output,
    source: await sourceProvenance(root),
    jobCapture: process.env.ASTER_NATIVE_JOB_CAPTURE === "1",
    videoOverride: process.env.ASTER_NATIVE_VIDEO_OVERRIDE,
    url: `http://127.0.0.1:${server.httpServer.address().port}/${entry}`,
  });
  const result = await runStep(
    {
      id: "electron",
      file: electron,
      args: ["scripts/migration/native-media-frame-electron.mjs"],
      timeout_ms: 240000,
      env: { ASTER_MEDIA_FRAME_CONFIG: config },
    },
    { root, output, env: process.env },
  );
  await writeAtomicJson(join(output, "process.json"), result);
  assert.equal(result.status, "passed", result.log);
} finally {
  if (server) await new Promise((close) => server.httpServer.close(close));
}
