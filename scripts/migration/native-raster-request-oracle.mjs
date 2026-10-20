import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Observe retained raster inputs separately from raster pixels and whole-frame plans. */
export async function captureRasterRequestOracle(root, output, env) {
  const sources = [];
  for (const path of [
    "scripts/migration/native-raster-request-oracle.mjs",
    "src/core/project/project-schema.ts",
    "src/core/scene/scene-evaluation.ts",
    "src/core/animation/layer-time.ts",
    "src/renderer/text/text-scene-preparation.ts",
    "src/renderer/text/text-motion-blur-plan.ts",
    "src/renderer/text/text-rasterizer.ts",
    "src/renderer/media/imported-raster-preparation.ts",
    "src/renderer/media/media-loading.ts",
    "src/importers/svg-raster-cache.ts",
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
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const cases = [];
    let state = 0xa57e17b;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (const item of corpus.cases) {
      let path =
        item.project === "env:ASTER_PERF_PROJECT"
          ? env.ASTER_PERF_PROJECT
          : join(root, item.project);
      assert(path);
      if ((await stat(path)).isDirectory()) path = join(path, "project.json");
      const raw = await readFile(path);
      const project = cloneCurrentProjectDocument(JSON.parse(raw));
      if (
        !project.compositions.some((c) => c.layers.some((l) => l.kind === "text")) &&
        !project.sources?.some((s) => ["svg", "psd"].includes(s.kind))
      )
        continue;
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
      const times = [
        ...item.frames.map((f) => f / rate),
        ...Array.from({ length: 64 }, () => random() * composition.duration),
      ];
      const samples = times.map((time, index) => {
        const context = {
          resolutionScale: [1, 1.25, 2, 4][index % 4],
          maximumDimension: 8192,
          maximumPixels: 67108864,
        };
        const request = {
          compositionId: composition.id,
          time,
          locale: new Intl.Collator().resolvedOptions().locale,
          context,
        };
        const exposure = planTextMotionBlurFrame({
          composition,
          project,
          frameTime: time,
          sceneLayers: flattenSceneLayers(composition, project, time),
          resolutionScale: context.resolutionScale,
        });
        const expected = [];
        for (const scene of exposure.renderSceneLayers) {
          const base = {
            compositionId: scene.sourceComposition.id,
            layerId: scene.layer.id,
            instanceId: scene.resourceInstanceId,
          };
          if (scene.layer.kind === "text")
            expected.push({
              ...base,
              kind: "text",
              sourceTime: evaluateLayerSourceTime(scene.layer, scene.localTime),
              frameRate: rate,
              resolutionScale: transformedTextRasterScale(
                context.resolutionScale,
                scene.transform.scale,
              ),
              exposure: exposure.plans.get(scene.resourceInstanceId) ?? null,
            });
          else {
            const source = project.sources?.find((s) => s.id === scene.layer.sourceId);
            if (source?.kind === "svg") {
              const { target } = prepareSvgRaster(
                scene.layer,
                source,
                scene.localTime,
                "verified-source",
                context.resolutionScale,
                context.maximumDimension,
              );
              expected.push({
                ...base,
                kind: "svg",
                sourceId: source.id,
                width: target.width,
                height: target.height,
              });
            } else if (source?.kind === "psd")
              expected.push({ ...base, kind: "psd", sourceId: source.id });
          }
        }
        return { request, expected };
      });
      cases.push({ id: item.id, project: { path, sha256: sha256(raw) }, layouts, samples });
    }
    await writeAtomicJson(output, { sources, cases });
    return {
      cases: cases.length,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      requests: cases.reduce((n, c) => n + c.samples.reduce((n, s) => n + s.expected.length, 0), 0),
    };
  } finally {
    await server.close();
  }
}
