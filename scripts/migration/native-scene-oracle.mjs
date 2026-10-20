import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureSceneOracle(root, output, projectInputs) {
  const sources = [];
  for (const path of [
    "src/core/scene/scene-evaluation.ts",
    "src/core/scene/cloner.ts",
    "src/core/scene/camera-settings.ts",
    "src/core/scene/camera-properties.ts",
    "src/core/scene/camera-optics.ts",
    "src/renderer/scene/scene-camera.ts",
    "src/core/scene/camera-rig.ts",
    "src/renderer/scene/scene-lighting.ts",
    "src/renderer/geometry/geometry.ts",
    "src/renderer/geometry/vector-path.ts",
    "src/renderer/geometry/bezier-geometry-cache.ts",
    "src/core/animation/path-morph.ts",
    "src/core/layers/solid-layer.ts",
    "shaders/manifest.json",
    "src/core/animation/layer-time.ts",
    "src/core/project/project-render-boundaries.ts",
    "src/core/animation/expressions.ts",
    "src/core/animation/timeline.ts",
    "src/core/animation/beat-functions.ts",
    "scripts/migration/native-scene-oracle.mjs",
    "scripts/migration/native-scene-fixtures.mjs",
    "tests/parity/corpus.json",
  ]) {
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  }
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  try {
    const runtime = await server.ssrLoadModule("/src/core/scene/scene-evaluation.ts");
    const { evaluateSceneCamera } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-camera.ts",
    );
    const { evaluateLayerSourceTime } = await server.ssrLoadModule(
      "/src/core/animation/layer-time.ts",
    );
    const { buildSceneLighting } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-lighting.ts",
    );
    const { buildSceneGeometry } = await server.ssrLoadModule("/src/renderer/geometry/geometry.ts");
    const { sceneFixtures } = await import("./native-scene-fixtures.mjs");
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const manifest = {
      version: 1,
      sources,
      cases: [],
      deferred_cloner_cases: [],
      samples: 0,
      scene_rows: 0,
    };
    let state = 0xa57e9005;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    async function capture(id, project, projectInput, compositionId, times, deferCloner) {
      const composition = project.compositions.find((c) => c.id === compositionId);
      assert(composition, `Missing source composition: ${id}`);
      const samples = [];
      for (const time of [...new Set(times)]) {
        const visible = runtime.visibleLayersAtTime(composition, time).map((layer) => layer.id);
        const world = composition.layers.map((layer) => ({
          layer_id: layer.id,
          transform: runtime.evaluateWorldTransform(layer, composition, time),
          source_time: evaluateLayerSourceTime(layer, time, composition.duration),
        }));
        let layers;
        let resources;
        let error = false;
        if (!deferCloner) {
          try {
            const flattened = runtime.flattenSceneLayers(composition, project, time);
            {
              const textBounds = {};
              if (time > composition.duration / 2)
                for (const entry of flattened) {
                  if (entry.layer.kind === "text")
                    textBounds[entry.resourceInstanceId] = {
                      x: -12,
                      y: -8,
                      width: entry.layer.size[0] + 25,
                      height: entry.layer.size[1] + 17,
                    };
                }
              const camera = evaluateSceneCamera(composition, time);
              const geometry = buildSceneGeometry(
                composition,
                flattened,
                camera,
                (id) => textBounds[id],
              );
              resources = {
                text_bounds: textBounds,
                lighting: Array.from(
                  buildSceneLighting(flattened, composition, true, camera?.pose.position),
                ),
                geometry: {
                  data: Array.from(geometry.data),
                  batches: geometry.batches.map(
                    ({
                      instanceId,
                      resourceInstanceId,
                      selectionId,
                      firstVertex,
                      vertexCount,
                    }) => ({
                      instanceId,
                      resourceInstanceId,
                      selectionId,
                      firstVertex,
                      vertexCount,
                    }),
                  ),
                },
              };
            }
            layers = flattened.map((entry) => ({
              layerId: entry.layer.id,
              sourceCompositionId: entry.sourceComposition.id,
              transform: entry.transform,
              localTime: entry.localTime,
              instanceId: entry.instanceId,
              resourceInstanceId: entry.resourceInstanceId,
              selectionId: entry.selectionId,
              ...(entry.precompositionSurface
                ? {
                    precompositionSurface: {
                      compositionId: entry.precompositionSurface.composition.id,
                      time: entry.precompositionSurface.time,
                      compositionPath: entry.precompositionSurface.compositionPath,
                    },
                  }
                : {}),
            }));
          } catch {
            error = true;
          }
        }
        samples.push({
          time,
          visible,
          world,
          camera: evaluateSceneCamera(composition, time) ?? null,
          resources,
          ...(deferCloner ? { deferred_cloner: true } : { layers, error }),
        });
        manifest.scene_rows += layers?.length ?? 0;
      }
      const path = join(output, `scene-${manifest.cases.length}.json`);
      await writeAtomicJson(path, {
        id,
        project: projectInput,
        composition_id: compositionId,
        duration: composition.duration,
        size: [composition.width, composition.height],
        samples,
      });
      manifest.cases.push({ path: local(path), sha256: sha256(await readFile(path)) });
      manifest.samples += samples.length;
      if (deferCloner) manifest.deferred_cloner_cases.push(id);
    }
    for (const input of projectInputs) {
      const path = isAbsolute(input.path) ? input.path : join(root, input.path);
      const bytes = await readFile(path);
      assert.equal(sha256(bytes), input.sha256);
      const project = JSON.parse(bytes);
      const deferCloner = false;
      for (const id of input.cases) {
        const item = corpus.cases.find((c) => c.id === id);
        assert(item);
        const composition = project.compositions.find((c) => c.id === item.composition);
        assert(composition);
        const times = item.frames.map(
          (frame) => (frame * composition.frameRate.denominator) / composition.frameRate.numerator,
        );
        times.push(...Array.from({ length: 64 }, () => random() * composition.duration));
        await capture(id, project, input, composition.id, times, deferCloner);
      }
    }
    const base = JSON.parse(
      await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
    );
    for (const fixture of sceneFixtures(base)) {
      const path = join(output, `${fixture.id}-project.json`);
      await writeAtomicJson(path, fixture.project);
      const input = { path: local(path), sha256: sha256(await readFile(path)) };
      await capture(
        fixture.id,
        fixture.project,
        input,
        fixture.project.activeCompositionId,
        fixture.times,
        false,
      );
    }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
      );
    const path = join(output, "scene-oracle.json");
    await writeAtomicJson(path, manifest);
    return {
      output: local(path),
      sha256: sha256(await readFile(path)),
      cases: manifest.cases.length,
      samples: manifest.samples,
      scene_rows: manifest.scene_rows,
      deferred_cloner_cases: manifest.deferred_cloner_cases,
    };
  } finally {
    await server.close();
  }
}
