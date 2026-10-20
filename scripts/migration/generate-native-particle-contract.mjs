import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Build-time metadata transfer; native execution loads shared WGSL without a TS runtime. */
export async function nativeParticleContract(root) {
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { bundledParticleDefinition: d } = await server.ssrLoadModule(
      "/src/renderer/scene/bundled-particle-generator.ts",
    );
    return {
      definition: {
        pluginId: d.pluginId,
        nodeType: d.nodeType,
        apiVersion: d.apiVersion,
        parameters: d.parameters,
        graph: d.graph,
        audioAnalysis: d.audioAnalysis,
      },
      pluginName: d.pluginName,
      runtimeKey: d.runtimeKey,
      shaders: Object.entries(d.shaderSources).map(([path, source]) => ({
        path,
        id: path.replace(/\.wgsl$/, ""),
        sha256: sha256(Buffer.from(source)),
      })),
    };
  } finally {
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = resolve("crates/aster-render-project/src/bundled-particles.json");
  const contract = await nativeParticleContract(process.cwd());
  if (process.argv.includes("--check"))
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), contract);
  else await writeAtomicJson(path, contract);
}
