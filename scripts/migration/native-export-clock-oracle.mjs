import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Capture the production TS absolute frame clock without reproducing its arithmetic. */
export async function captureExportClockOracle(root, output) {
  await mkdir(output, { recursive: true });
  const source = join(root, "src/core/rendering/render-export.ts");
  const sourceHash = await hashFile(source);
  const project = JSON.parse(
    await readFile(join(root, "examples/projects/minimal-golden.aster.json"), "utf8"),
  );
  const composition = project.compositions[0];
  composition.duration = 40;
  const projectPath = resolve(output, "project.json");
  await writeAtomicJson(projectPath, project);
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { frameTimeAtIndex } = await server.ssrLoadModule("/src/core/rendering/render-export.ts");
    const cases = [];
    for (const [numerator, denominator] of [
      [30, 1],
      [60, 1],
      [30000, 1001],
      [60000, 1001],
    ]) {
      for (const startFrame of [0, 1, 5, 30, 714]) {
        const frameRate = { numerator, denominator };
        cases.push({
          settings: {
            composition: composition.id,
            startTime: 0,
            startFrame,
            frameCount: 300,
            frameRate,
            size: { width: 320, height: 180 },
            bitrateBps: 20000000,
            antiAliasing: "off",
          },
          start_time: frameTimeAtIndex(startFrame, frameRate),
          times: Array.from({ length: 300 }, (_, index) =>
            frameTimeAtIndex(startFrame + index, frameRate),
          ),
        });
      }
    }
    assert.equal(await hashFile(source), sourceHash);
    const path = resolve(output, "oracle.json");
    await writeAtomicJson(path, {
      source: { path: source, sha256: sourceHash },
      project: projectPath,
      project_sha256: await hashFile(projectPath),
      cases,
    });
    return {
      path,
      sha256: await hashFile(path),
      cases: cases.length,
      addresses: cases.length * 300,
    };
  } finally {
    await server.close();
  }
}
