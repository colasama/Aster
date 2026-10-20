import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureEffectPlanOracle(root, output, projectInputs) {
  const manifest = JSON.parse(
    await readFile(join(root, "crates/aster-eval/src/effects/program/source-manifest.json")),
  );
  const sources = [...manifest.sources];
  for (const path of [
    "scripts/migration/native-effect-plan-oracle.mjs",
    "src/renderer/frame-plan/bundle-effect-records.ts",
    "src/renderer/frame-plan/precomposition-bundle-resources.ts",
    "src/renderer/frame-plan/resources.ts",
    "src/renderer/frame-plan/codec.ts",
    "src/renderer/effects/layer-effect-plan.ts",
    "src/renderer/effects/effect-fusion.ts",
    "src/renderer/compositing/layer-composite.ts",
    "src/renderer/frame-plan/effect-execution-plan.ts",
    "src/renderer/frame-plan/layer-effect-plan.ts",
    "src/renderer/media/lut-selection-plan.ts",
    "src/renderer/media/lut-texture.ts",
    "src/core/media/half-float.ts",
    "src/renderer/effects/post-process.ts",
    "src/renderer/effects/effect-parameters.ts",
  ])
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { prepareLayerEffect } = await server.ssrLoadModule(
      "/src/renderer/effects/layer-effect-plan.ts",
    );
    const { LutSelectionPlanner } = await server.ssrLoadModule(
      "/src/renderer/media/lut-selection-plan.ts",
    );
    const { buildFrameHeader } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-post-plan.ts",
    );
    const { buildBundleEffects } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/bundle-effect-records.ts",
    );
    const { PrecompositionBundleResources } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/precomposition-bundle-resources.ts",
    );
    const { EFFECT_REGISTRY } = await server.ssrLoadModule("/src/effects/registry.ts");
    const cases = [],
      seen = new Set();
    let template,
      compositionTemplate,
      corpusLayers = 0;
    const owned = (plan) => ({
      metadata: plan.metadata,
      blobs: plan.blobs.map((b) => Array.from(b)),
    });
    function capture(layer, composition, contexts = ["root", "precomposition", "isolated"]) {
      for (const [i, context] of contexts.entries()) {
        const time = [0.125, 1.75, -0.5][i],
          mipLevelCount = [1, 4, 8][i];
        const header = buildFrameHeader({
          snapshot: { snapshotScope: "native-effect-producer", projectRevision: 17 },
          compositionId: composition.id,
          time,
          frameRate: composition.frameRate,
          target: { width: 320, height: 180 },
          renderTarget: { width: 640, height: 360 },
          antiAliasing: "ssaa2x",
        });
        const instanceId = `effect/${layer.id}`,
          pixelScale = Math.min(640 / composition.width, 360 / composition.height);
        const prepared = prepareLayerEffect({
          header,
          composition,
          layer,
          instanceId,
          time,
          mipLevelCount,
          context,
          planner: new LutSelectionPlanner(),
        });
        const expected = { status: prepared.status, execution: owned(prepared.execution) };
        if (prepared.status === "ready") {
          expected.plan = owned(prepared.plan);
          const { message, bytes, label } = prepared.lut.resource;
          expected.lut = {
            hash: message.hash,
            kind: message.kind,
            descriptor: message.descriptor,
            bytes: Array.from(bytes),
            label,
          };
        }
        const resources = new PrecompositionBundleResources();
        const records = buildBundleEffects(new Map([[instanceId, prepared]]), resources);
        expected.bundle = {
          records,
          resources: [...resources.used].sort().map((hash) => {
            const r = resources.resolve(hash);
            return {
              message: r.message,
              byte_length: r.bytes.length,
              payload_sha256: sha256(r.bytes),
            };
          }),
        };
        cases.push({
          layer,
          header,
          context,
          instanceId,
          time,
          pixelScale,
          mipLevelCount,
          expected,
        });
      }
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const composition of JSON.parse(bytes).compositions)
        for (const layer of composition.layers) {
          template ??= layer;
          compositionTemplate ??= composition;
          const key = JSON.stringify([layer.kind, layer.blendMode, layer.effects]);
          if (seen.has(key)) continue;
          seen.add(key);
          corpusLayers++;
          capture(layer, composition);
        }
    }
    assert(template && compositionTemplate);
    const effect = (type, id = type) => {
      const def = EFFECT_REGISTRY.find((e) => e.type === type);
      return {
        id,
        type,
        name: type,
        enabled: true,
        parameters: Object.fromEntries((def?.parameters ?? []).map((p) => [p.key, p.defaultValue])),
      };
    };
    const synthetic = (effects, blendMode = "normal", kind = "solid") =>
      capture({ ...template, id: "synthetic", kind, blendMode, effects }, compositionTemplate);
    for (const def of EFFECT_REGISTRY) synthetic([effect(def.type)]);
    for (const blend of [
      "normal",
      "add",
      "screen",
      "multiply",
      "overlay",
      "darken",
      "lighten",
      "color-burn",
      "color-dodge",
      "soft-light",
      "hard-light",
      "difference",
      "exclusion",
    ])
      for (const kind of ["solid", "adjustment"]) synthetic([], blend, kind);
    const mask = {
      shape: "ellipse",
      center: [0.5, 0.5],
      size: [0.7, 0.6],
      feather: 0.1,
      opacity: 0.8,
      invert: false,
    };
    synthetic(
      Array.from({ length: 70 }, (_, i) => ({
        ...effect(i % 7 === 0 ? "unknown" : i % 3 === 0 ? "glow" : "exposure", `overflow-${i}`),
        ...(i % 2 ? { mask } : {}),
      })),
    );
    synthetic(
      [{ ...effect("exposure"), enabled: false }, effect("unknown")],
      "multiply",
      "adjustment",
    );
    const data = Array.from(
      { length: 24 },
      (_, i) => [0, 1, -2, 1.00048828125, 2 ** -25, 65505, -65505, 0.333333333][i % 8],
    );
    const lut = (checksum) => ({
      ...effect("lut"),
      resource: {
        kind: "lut3d",
        name: checksum,
        checksum,
        size: 2,
        data,
        domainMin: [0, 0, 0],
        domainMax: [1, 1, 1],
      },
    });
    synthetic([lut("a"), effect("exposure"), { ...lut("b"), id: "b" }, { ...lut("a"), id: "c" }]);
    synthetic([lut("a"), { ...lut("b"), enabled: false }, { ...lut("b"), id: "c" }]);
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, { version: 1, sources, cases });
    return {
      cases: cases.length,
      corpus_layers: corpusLayers,
      registered_effects: EFFECT_REGISTRY.length,
      scope: "native-effect-routing-program-and-lut-producers",
      whole_project_plan_parity: false,
    };
  } finally {
    await server.close();
  }
}
