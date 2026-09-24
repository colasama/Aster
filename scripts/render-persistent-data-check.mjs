// Run in an unbundled Vite browser; see docs/BENCHMARKS.md.
import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import { flattenSceneLayers } from "/src/core/scene/scene-evaluation.ts";
import { staticValue } from "/src/core/types.ts";
import { summarizeSamples } from "/src/renderer/diagnostics/gpu-benchmark.ts";
import { buildSceneGeometry } from "/src/renderer/geometry/geometry.ts";

export function prepareVectors(composition) {
  // Separate imported-style curved paths, animated only in position/rotation.
  for (const [index, layer] of composition.layers.entries()) {
    layer.shape.kind = "bezier";
    layer.shape.strokeWidth = 2;
    layer.shape.path = {
      closed: true,
      vertices: Array.from({ length: 160 }, (_, vertex) => {
        const angle = (vertex / 160) * Math.PI * 2;
        const radius = 0.38 + 0.1 * Math.sin(angle * (5 + (index % 3)));
        return {
          position: [Math.cos(angle) * radius, Math.sin(angle) * radius],
          inTangent: [-Math.sin(angle) * 0.003, Math.cos(angle) * 0.003],
          outTangent: [Math.sin(angle) * 0.003, -Math.cos(angle) * 0.003],
        };
      }),
    };
  }
}

export function prepareHierarchy(composition) {
  const parents = Array.from({ length: 24 }, (_, index) => {
    const layer = createLayerForComposition("null", composition);
    layer.id = `joint-${index}`;
    layer.parentId = index % 8 ? `joint-${index - 1}` : undefined;
    layer.transform.position = [staticValue(2), staticValue(2), staticValue(0)];
    layer.expressions = { "rotation.2": "sin(time * 2) * 5" };
    return layer;
  });
  const shapes = Array.from({ length: 240 }, (_, index) => {
    const layer = createLayerForComposition("shape", composition);
    layer.parentId = parents[(index % 3) * 8 + 7].id;
    layer.size = [50, 50];
    layer.transform.anchor = [staticValue(25), staticValue(25), staticValue(0)];
    layer.transform.position[0] = staticValue((composition.width * (index % 20)) / 20);
    layer.transform.position[1] = staticValue((composition.height * (index % 12)) / 12);
    return layer;
  });
  composition.layers = [...shapes, ...parents];
}

export function profilePreparation({
  flatten = flattenSceneLayers,
  geometry = buildSceneGeometry,
  scene = "vectors",
  frameCount = 100,
} = {}) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.duration = 30;
  composition.layers = Array.from({ length: 20 }, () =>
    createLayerForComposition("shape", composition),
  );
  (scene === "vectors" ? prepareVectors : prepareHierarchy)(composition);
  const evaluationMs = [];
  const geometryMs = [];
  let vertices = 0;
  for (let frame = -10; frame < frameCount; frame++) {
    const start = performance.now();
    const layers = flatten(composition, project, (frame + 10) / 30);
    const evaluated = performance.now();
    const result = geometry(composition, layers);
    const end = performance.now();
    vertices = result.data.length / 40;
    if (frame < 0) continue;
    evaluationMs.push(evaluated - start);
    geometryMs.push(end - evaluated);
  }
  return {
    scene,
    layers: composition.layers.length,
    vertices,
    frameCount,
    evaluationMs: summarizeSamples(evaluationMs),
    geometryMs: summarizeSamples(geometryMs),
    evaluationSamplesMs: evaluationMs,
    geometrySamplesMs: geometryMs,
  };
}

/** Compare every packed vertex attribute, including after edits that must invalidate topology. */
export function checkGeometryParity({ baselineFlatten, baselineGeometry }) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.layers = Array.from({ length: 3 }, () =>
    createLayerForComposition("shape", composition),
  );
  prepareVectors(composition);
  const shape = composition.layers[0];
  const parent = createLayerForComposition("null", composition);
  parent.expressions = { "rotation.2": "sin(time) * 30" };
  shape.parentId = parent.id;
  const mesh = createLayerForComposition("mesh", composition);
  composition.layers.push(mesh, createLayerForComposition("shape", composition), parent);
  const times = [0, 1 / 30, 1.25, 0.5];
  let cases = 0;
  let comparedFloats = 0;
  const compare = () => {
    for (const time of times) {
      const previous = baselineGeometry(composition, baselineFlatten(composition, project, time));
      const next = buildSceneGeometry(composition, flattenSceneLayers(composition, project, time));
      if (previous.data.length !== next.data.length) throw new Error("Vertex count changed");
      const before = new Uint8Array(
        previous.data.buffer,
        previous.data.byteOffset,
        previous.data.byteLength,
      );
      const after = new Uint8Array(next.data.buffer, next.data.byteOffset, next.data.byteLength);
      if (before.some((value, index) => value !== after[index]))
        throw new Error(`Vertex data changed in case ${cases}`);
      if (JSON.stringify(previous.batches) !== JSON.stringify(next.batches))
        throw new Error("Draw batches changed");
      cases++;
      comparedFloats += next.data.length;
    }
  };
  compare();
  shape.shape.path.vertices[0].outTangent[0] += 0.05;
  shape.shape.trim = { start: 80, end: 25, offset: 15 };
  shape.transform.scale[0] = staticValue(-125.125);
  compare();
  shape.threeDimensional = true;
  shape.transform.rotation[0] = staticValue(21);
  shape.transform.rotation[1] = staticValue(37);
  shape.shape.lineJoin = "bevel";
  shape.shape.lineCap = "butt";
  shape.shape.strokeWidth = 7;
  compare();
  shape.shape.morph = {
    target: structuredClone(shape.shape.path),
    progress: {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 0, interpolation: "linear" },
        { id: "end", time: 1.25, value: 100, interpolation: "linear" },
      ],
    },
  };
  shape.shape.morph.target.vertices[2].position[0] -= 0.15;
  compare();
  return { cases, comparedFloats, parity: "byte-identical" };
}
