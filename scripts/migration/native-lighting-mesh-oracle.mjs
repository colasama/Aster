import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureLightingMeshOracle(root, output, projectInputs) {
  const sources = [];
  for (const path of [
    "src/renderer/scene/scene-lighting.ts",
    "src/renderer/geometry/geometry.ts",
    "src/core/scene/scene-evaluation.ts",
    "src/core/layers/solid-layer.ts",
    "src/core/scene/camera-settings.ts",
    "src/core/scene/camera-properties.ts",
    "src/core/scene/camera-optics.ts",
    "src/core/scene/camera-rig.ts",
    "src/renderer/scene/scene-camera.ts",
    "shaders/manifest.json",
    "scripts/migration/native-lighting-mesh-oracle.mjs",
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
    const { buildSceneLighting, shadowMapSize } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-lighting.ts",
    );
    const { buildSceneGeometry } = await server.ssrLoadModule("/src/renderer/geometry/geometry.ts");
    const { evaluateWorldTransform, visibleLayersAtTime } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { evaluateSceneCamera } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-camera.ts",
    );
    const { createDefaultEvaluatedCamera } = await server.ssrLoadModule(
      "/src/core/scene/camera-settings.ts",
    );
    const lighting = [],
      meshes = [],
      seen = new Set();
    let state = 0xa57e9007;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    function entry(layer, transform, composition) {
      return {
        layer,
        transform,
        sourceComposition: composition,
        localTime: 0,
        instanceId: layer.id,
        resourceInstanceId: layer.id,
        selectionId: layer.id,
      };
    }
    function lights(composition, rows, shadows, camera) {
      lighting.push({
        size: [composition.width, composition.height],
        layers: rows.map(({ layer, transform }) => ({ layer, transform })),
        shadows,
        camera,
        data: Array.from(buildSceneLighting(rows, composition, shadows, camera)),
        shadow_size: shadowMapSize(
          rows.find((r) => r.layer.kind === "light")?.layer.light?.shadowQuality ?? "medium",
        ),
      });
    }
    function mesh(layer, composition, times, override) {
      const samples = times.map((time) => {
        const transform = override ?? evaluateWorldTransform(layer, composition, time);
        const camera =
          evaluateSceneCamera(composition, time) ??
          createDefaultEvaluatedCamera(composition.width, composition.height);
        const result = buildSceneGeometry(
          composition,
          [entry(layer, transform, composition)],
          camera,
        );
        assert.equal(result.batches.length, 1);
        assert.equal(result.batches[0].firstVertex, 0);
        return {
          time,
          transform,
          camera,
          data: Array.from(result.data),
          vertex_count: result.batches[0].vertexCount,
        };
      });
      meshes.push({ layer, size: [composition.width, composition.height], samples });
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const composition of JSON.parse(bytes).compositions) {
        const relevant = composition.layers.filter((l) => l.kind === "mesh" || l.kind === "light");
        if (!relevant.length) continue;
        const key = JSON.stringify([composition.width, composition.height, composition.layers]);
        if (seen.has(key)) continue;
        seen.add(key);
        const times = [
          0,
          composition.duration,
          ...Array.from({ length: 64 }, () => random() * composition.duration),
        ];
        if (relevant.some((l) => l.kind === "light"))
          for (const time of times) {
            const rows = visibleLayersAtTime(composition, time)
              .filter((l) => l.kind === "light")
              .map((layer) =>
                entry(layer, evaluateWorldTransform(layer, composition, time), composition),
              );
            lights(
              composition,
              rows,
              true,
              evaluateSceneCamera(composition, time)?.pose.position ?? [
                composition.width / 2,
                composition.height / 2,
                0,
              ],
            );
          }
        for (const layer of relevant.filter((l) => l.kind === "mesh"))
          mesh(layer, composition, times);
      }
    }
    const base = JSON.parse(
      await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
    );
    const composition = base.compositions[0];
    const original = structuredClone(composition.layers[0]);
    const transform = {
      position: [160, 90, 20],
      rotation: [33, -17, 41],
      scale: [100, 100, 100],
      anchor: [27, 19, 5],
      opacity: 0.37,
    };
    const rows = [];
    lights(composition, [], true, undefined);
    for (let i = 0; i < 10; i++) {
      const layer = {
        ...structuredClone(original),
        id: `light-${i}`,
        kind: "light",
        color: [0.2, 0.8, 1.5, 0.3],
        light: {
          kind: ["directional", "point", "spot"][i % 3],
          intensity: 1.25 + i,
          range: 1000 + i * 200,
          coneAngle: 5 + i * 10,
          shadowQuality: ["off", "low", "medium", "high"][i % 4],
        },
      };
      rows.push(entry(layer, { ...transform, rotation: [i * 15, i * 7, i * 17] }, composition));
      lights(composition, rows, true, [10, 20, -1000]);
      lights(composition, rows, false, undefined);
    }
    const geometry = {
      name: "triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 1],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    };
    for (let i = 0; i < 12; i++) {
      const layer = {
        ...structuredClone(original),
        id: `mesh-${i}`,
        kind: "mesh",
        size: [240, 100],
        color: [5, -0.2, 0.6, 0.7],
      };
      delete layer.shape;
      if (i !== 0) layer.mesh = structuredClone(geometry);
      if (i === 2) layer.mesh.tangents = [1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1];
      if (i === 3) layer.mesh.positions.fill(0);
      if (i === 4) {
        layer.mesh.positions = [];
        layer.mesh.normals = [];
        layer.mesh.uvs = [];
        layer.mesh.indices = [];
      }
      const material = {
        metallic: 0.9,
        roughness: 0.2,
        emissive: 0.3,
        alphaMode: ["opaque", "mask", "blend"][i % 3],
        alphaCutoff: 0.4,
      };
      if (i >= 5) {
        layer.mesh.sourceMaterial = material;
        layer.mesh.baseColor = [0.2, 0.4, 0.6, 0.8];
      }
      if (i === 6) layer.material = { ...material, metallic: 0.1 };
      for (const scale of [
        [100, 100, 100],
        [-125, 75, 50],
        [0, 100, 100],
      ])
        mesh(layer, composition, [0], { ...transform, scale });
    }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
      );
    await writeAtomicJson(output, { version: 1, sources, lighting, meshes });
    return {
      lighting_cases: lighting.length,
      mesh_cases: meshes.length,
      mesh_samples: meshes.reduce((n, c) => n + c.samples.length, 0),
      corpus_compositions: seen.size,
    };
  } finally {
    await server.close();
  }
}
