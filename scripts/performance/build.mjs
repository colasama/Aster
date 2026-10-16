import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "vite";

assert.equal(process.env.NODE_ENV, "production", "Performance builds require production mode");
assert(process.argv[2], "A fresh output directory is required");
const root = process.cwd();
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
await build({
  configFile: false,
  root,
  logLevel: "warn",
  base: "/",
  define: { __APP_VERSION__: JSON.stringify("migration-performance") },
  build: {
    outDir: output,
    emptyOutDir: false,
    rolldownOptions: { input: join(root, "tests/performance/harness.html") },
  },
});
