// Import in an unbundled Vite browser; see docs/BENCHMARKS.md.
import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import { flattenSceneLayers } from "/src/core/scene/scene-evaluation.ts";
import { staticValue } from "/src/core/types.ts";
import { summarizeSamples } from "/src/renderer/diagnostics/gpu-benchmark.ts";
import { buildSceneGeometry } from "/src/renderer/geometry/geometry.ts";
import { evaluateSceneCamera } from "/src/renderer/scene/scene-camera.ts";
import { prepareVectors } from "./render-persistent-data-check.mjs";

function fixture(scene) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = 1920;
  composition.height = 1080;
  composition.duration = 60;
  composition.layers = Array.from({ length: 8 }, (_, index) => {
    const layer = createLayerForComposition("shape", composition);
    layer.id = `vector-${index}`;
    layer.size = [180, 180];
    layer.transform.anchor = [staticValue(90), staticValue(90), staticValue(0)];
    layer.transform.position = [
      staticValue(300 + (index % 4) * 400),
      staticValue(300 + Math.floor(index / 4) * 400),
      staticValue(index * 20),
    ];
    layer.expressions = { "rotation.2": "time * 12" };
    layer.threeDimensional = scene !== "vectors2d";
    return layer;
  });
  prepareVectors(composition);
  for (const layer of composition.layers)
    layer.shape.path.vertices = layer.shape.path.vertices.filter((_, index) => index % 4 === 0);
  if (scene === "mesh3d") {
    const mesh = createLayerForComposition("mesh", composition);
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const side = 40;
    for (let y = 0; y <= side; y++)
      for (let x = 0; x <= side; x++) {
        positions.push(x / side - 0.5, y / side - 0.5, Math.sin(x * 0.2) * 0.1);
        normals.push(0, 0, 1);
        uvs.push(x / side, y / side);
        if (x < side && y < side) {
          const i = y * (side + 1) + x;
          indices.push(i, i + 1, i + side + 1, i + 1, i + side + 2, i + side + 1);
        }
      }
    mesh.mesh = { positions, normals, uvs, indices };
    mesh.expressions = { "rotation.1": "time * 12" };
    composition.layers = [mesh];
  }
  return { project, composition };
}

export function measure({ scene = "vectors3d", geometry = buildSceneGeometry, frames = 600 } = {}) {
  const { project, composition } = fixture(scene);
  const samplesMs = [];
  let vertexCount;
  for (let frame = -20; frame < frames; frame++) {
    const time = (frame + 20) / 30;
    const layers = flattenSceneLayers(composition, project, time);
    const start = performance.now();
    const result = geometry(composition, layers);
    const elapsed = performance.now() - start;
    vertexCount = result.data.length / 40;
    if (frame >= 0) samplesMs.push(elapsed);
  }
  return {
    scene,
    frames,
    warmupFrames: 20,
    vertexCount,
    geometryMs: summarizeSamples(samplesMs),
    samplesMs,
  };
}

export function checkParity(baselineGeometry) {
  let cases = 0;
  let comparedBytes = 0;
  for (const scene of ["vectors2d", "vectors3d", "mesh3d"]) {
    const { project, composition } = fixture(scene);
    const camera = createLayerForComposition("camera", composition);
    camera.transform.rotation[2] = staticValue(9);
    camera.camera.orientation[1] = staticValue(7);
    for (const mode of ["default", "oneNode", "twoNode"]) {
      composition.layers = composition.layers.filter((layer) => layer.kind !== "camera");
      if (mode !== "default") {
        camera.camera.mode = mode;
        composition.layers.push(camera);
      }
      for (const projection of ["perspective", "orthographic"]) {
        camera.camera.projection = projection;
        for (const time of [0, 0.6, 1.25, 0.1]) {
          const layers = flattenSceneLayers(composition, project, time);
          const evaluatedCamera = evaluateSceneCamera(composition, time);
          const before = baselineGeometry(composition, layers, evaluatedCamera);
          const after = buildSceneGeometry(composition, layers, evaluatedCamera);
          const a = new Uint8Array(
            before.data.buffer,
            before.data.byteOffset,
            before.data.byteLength,
          );
          const b = new Uint8Array(after.data.buffer, after.data.byteOffset, after.data.byteLength);
          if (a.length !== b.length || a.some((value, index) => value !== b[index]))
            throw new Error(`Geometry changed: ${scene}/${mode}/${projection}/${time}`);
          if (JSON.stringify(before.batches) !== JSON.stringify(after.batches))
            throw new Error("Draw batches changed");
          cases++;
          comparedBytes += a.length;
        }
      }
    }
  }
  return { cases, comparedBytes, parity: "byte-identical" };
}
