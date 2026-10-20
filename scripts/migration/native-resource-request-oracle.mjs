import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Observe actual retained preparation rules independently of native resource traversal. */
export async function captureResourceRequestOracle(root, output, env) {
  const sources = [];
  for (const path of [
    "scripts/migration/native-resource-request-oracle.mjs",
    "src/core/project/project-schema.ts",
    "src/core/scene/scene-evaluation.ts",
    "src/core/animation/layer-time.ts",
    "src/renderer/webgpu-renderer.ts",
    "src/renderer/text/text-scene-preparation.ts",
    "src/renderer/text/text-motion-blur-plan.ts",
    "src/renderer/text/text-rasterizer.ts",
    "src/renderer/media/imported-raster-preparation.ts",
    "src/renderer/media/media-loading.ts",
    "src/renderer/compositing/precomposition-source-evaluation.ts",
    "src/renderer/compositing/precomposition-surface-renderer.ts",
    "src/renderer/compositing/precomposition-surface-plan.ts",
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
    const { cloneCurrentProjectDocument } = await server.ssrLoadModule(
      "/src/core/project/project-schema.ts",
    );
    const { flattenSceneLayers } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { evaluateLayerSourceTime } = await server.ssrLoadModule(
      "/src/core/animation/layer-time.ts",
    );
    const { segmentTextLayoutUnits } = await server.ssrLoadModule(
      "/src/core/animation/text-animator-stack.ts",
    );
    const { planTextMotionBlurFrame } = await server.ssrLoadModule(
      "/src/renderer/text/text-motion-blur-plan.ts",
    );
    const { transformedTextRasterScale } = await server.ssrLoadModule(
      "/src/renderer/text/text-rasterizer.ts",
    );
    const { prepareSvgRaster } = await server.ssrLoadModule(
      "/src/renderer/media/imported-raster-preparation.ts",
    );
    const { evaluatePrecompositionSources } = await server.ssrLoadModule(
      "/src/renderer/compositing/precomposition-source-evaluation.ts",
    );
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const inputs = [];
    for (const item of corpus.cases) {
      let path =
        item.project === "env:ASTER_PERF_PROJECT"
          ? env.ASTER_PERF_PROJECT
          : join(root, item.project);
      assert(path);
      if ((await stat(path)).isDirectory()) path = join(path, "project.json");
      const bytes = await readFile(path);
      inputs.push({
        item,
        project: cloneCurrentProjectDocument(JSON.parse(bytes)),
        proof: { path, sha256: sha256(bytes) },
      });
    }
    const nested = structuredClone(
      inputs.find((i) => i.item.id === "nested-precompositions").project,
    );
    const text = structuredClone(
      inputs.find((i) => i.item.id === "layer-text").project.compositions[0].layers[0],
    );
    const svg = inputs.find((i) => i.item.id === "media-svg").project;
    const [outer, middle, inner] = nested.compositions;
    for (const c of [outer, middle]) c.layers[0].threeDimensional = true;
    middle.frameRate = { numerator: 24, denominator: 1 };
    inner.frameRate = { numerator: 60, denominator: 1 };
    nested.sources = structuredClone(svg.sources);
    inner.layers.push({
      ...structuredClone(text),
      id: "inner-text",
      timeOffset: 0.125,
      timeStretch: 1.5,
    });
    inner.layers.push({ ...structuredClone(svg.compositions[0].layers[0]), id: "inner-svg" });
    middle.layers.push({ ...structuredClone(text), id: "middle-text" });
    outer.layers.push({ ...structuredClone(text), id: "outer-text" });
    outer.layers.push({ ...structuredClone(svg.compositions[0].layers[0]), id: "outer-svg" });
    // Shared child surfaces must not acquire their resources twice.
    outer.layers.push({ ...structuredClone(outer.layers[0]), id: "shared-child-wrapper" });
    for (const aa of ["off", "ssaa2x", "ssaa4x"])
      inputs.push({
        item: {
          id: `recursive-raster-${aa}`,
          composition: outer.id,
          size: { width: 320, height: 180 },
          aa,
          frames: [0, 7, 15, 23],
        },
        project: nested,
        inline: nested,
      });
    let state = 0xa57e17c;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const cases = [];
    for (const input of inputs) {
      const { item, project } = input;
      const composition = project.compositions.find((c) => c.id === item.composition);
      assert(composition);
      const layouts = Object.fromEntries(
        project.compositions.map((c) => [
          c.id,
          Object.fromEntries(
            c.layers
              .filter((l) => l.kind === "text")
              .map((l) => [l.id, segmentTextLayoutUnits(l.text ?? l.name)]),
          ),
        ]),
      );
      const rate = composition.frameRate.numerator / composition.frameRate.denominator;
      const scale = item.aa === "ssaa2x" ? 2 : item.aa === "ssaa4x" ? 4 : 1;
      const resolutionScale = Math.max(
        (item.size.width * scale) / composition.width,
        (item.size.height * scale) / composition.height,
      );
      const times = [
        ...item.frames.map((f) => f / rate),
        ...Array.from({ length: 64 }, () => random() * composition.duration),
      ];
      const samples = times.map((time, index) => {
        const frame = {
          snapshotScope: "native-resource-request-oracle",
          projectRevision: 7,
          compositionId: composition.id,
          time,
          target: item.size,
          renderTarget: { width: item.size.width * scale, height: item.size.height * scale },
          antiAliasing: item.aa,
          shadowsEnabled: true,
        };
        const visualization = input.inline && index % 3 === 1 ? "alpha" : "beauty";
        const surface = {
          revision: 7,
          maxTextureDimension: 8192,
          memoryBudgetMb: 256,
          renderScale: scale,
        };
        const context = {
          visualization,
          locale: new Intl.Collator().resolvedOptions().locale,
          surface,
          maximumRasterDimension: 8192,
          maximumRasterPixels: 67108864,
        };
        const rawScenes = flattenSceneLayers(composition, project, time);
        const exposure =
          visualization === "beauty"
            ? planTextMotionBlurFrame({
                composition,
                project,
                frameTime: time,
                sceneLayers: rawScenes,
                resolutionScale,
              })
            : { renderSceneLayers: rawScenes, plans: new Map() };
        const operations = [];
        const prepare = (scene, frameRate, density, exposure) => {
          const base = {
            compositionId: scene.sourceComposition.id,
            layerId: scene.layer.id,
            instanceId: scene.resourceInstanceId,
          };
          let request;
          if (scene.layer.kind === "text")
            request = {
              ...base,
              kind: "text",
              sourceTime: evaluateLayerSourceTime(scene.layer, scene.localTime),
              frameRate,
              resolutionScale: transformedTextRasterScale(density, scene.transform.scale),
              exposure: exposure ?? null,
            };
          else {
            const source = project.sources?.find((s) => s.id === scene.layer.sourceId);
            if (source?.kind === "svg") {
              const { target } = prepareSvgRaster(
                scene.layer,
                source,
                scene.localTime,
                "verified-source",
                density,
                8192,
              );
              request = {
                ...base,
                kind: "svg",
                sourceId: source.id,
                width: target.width,
                height: target.height,
              };
            } else if (source?.kind === "psd")
              request = { ...base, kind: "psd", sourceId: source.id };
            else {
              operations.push({
                kind: "media",
                ...base,
                sourceId: scene.layer.sourceId ?? null,
                localTime: scene.localTime,
              });
              return;
            }
          }
          operations.push({ kind: "raster", request });
        };
        for (const scene of exposure.renderSceneLayers)
          if (scene.layer.kind === "text")
            prepare(scene, rate, resolutionScale, exposure.plans.get(scene.resourceInstanceId));
        const child = evaluatePrecompositionSources({
          project,
          sceneLayers: exposure.renderSceneLayers,
          ...surface,
          enableTextMotionBlur: visualization === "beauty",
        });
        for (const operation of child.operations) {
          if (operation.kind === "target") operations.push(operation);
          else if (operation.kind === "media") {
            const scene = operation.scene;
            prepare(
              scene,
              scene.sourceComposition.frameRate.numerator /
                scene.sourceComposition.frameRate.denominator,
              scene.layer.kind === "text" ? operation.resolutionScale : 1,
              operation.textMotionBlur,
            );
          }
        }
        for (const scene of exposure.renderSceneLayers)
          if (["image", "video"].includes(scene.layer.kind)) prepare(scene, rate, resolutionScale);
        return {
          frame,
          context,
          expected: {
            operations,
            surfaceBindings: Object.fromEntries(child.bindings),
            diagnostics: child.diagnostics,
          },
        };
      });
      cases.push({ id: item.id, project: input.proof, inline: input.inline, layouts, samples });
    }
    await writeAtomicJson(output, { sources, cases });
    return {
      cases: cases.length,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      operations: cases.reduce(
        (n, c) => n + c.samples.reduce((n, s) => n + s.expected.operations.length, 0),
        0,
      ),
    };
  } finally {
    await server.close();
  }
}
