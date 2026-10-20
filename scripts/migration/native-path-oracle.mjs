import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function capturePathOracle(root, output, projectInputs) {
  const sources = [];
  for (const path of [
    "src/renderer/geometry/vector-path.ts",
    "src/renderer/geometry/bezier-geometry-cache.ts",
    "src/core/animation/path-morph.ts",
    "src/core/animation/timeline.ts",
    "src/core/animation/expressions.ts",
    "scripts/migration/native-path-oracle.mjs",
  ])
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  try {
    const vector = await server.ssrLoadModule("/src/renderer/geometry/vector-path.ts");
    const { cachedBezierGeometry } = await server.ssrLoadModule(
      "/src/renderer/geometry/bezier-geometry-cache.ts",
    );
    const { evaluateShapePath } = await server.ssrLoadModule("/src/core/animation/path-morph.ts");
    const cases = [];
    let samples = 0,
      state = 0xa57e9008;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    async function capture(shape, expression, size, times) {
      const values = times.map((time, index) => {
        const evaluated = evaluateShapePath(shape, time, expression);
        const dimensions =
          index % 3 === 0
            ? size
            : index % 3 === 1
              ? [-size[0] * 1.25, size[1] * 0.75]
              : [0, size[1]];
        const flattened = vector.flattenBezierPath(evaluated);
        const geometry = cachedBezierGeometry(evaluated, shape, ...dimensions);
        return {
          time,
          size: dimensions,
          evaluated,
          flattened,
          geometry: { fill: geometry.fill, stroke: geometry.stroke },
        };
      });
      const path = join(output, `path-${cases.length}.json`);
      await writeAtomicJson(path, { shape, expression: expression ?? null, samples: values });
      cases.push({ path: local(path), sha256: sha256(await readFile(path)) });
      samples += values.length;
    }
    const seen = new Set();
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const composition of JSON.parse(bytes).compositions)
        for (const layer of composition.layers) {
          if (!layer.shape?.path) continue;
          const expression = layer.expressions?.["shape.morphProgress"];
          const key = JSON.stringify([layer.shape, expression]);
          if (seen.has(key)) continue;
          seen.add(key);
          const times = layer.shape.morph
            ? [
                0,
                composition.duration,
                ...Array.from({ length: 64 }, () => random() * composition.duration),
              ]
            : [0, 0.5, 1];
          await capture(layer.shape, expression, layer.size, times);
        }
    }
    const vertex = (position) => ({ position, inTangent: [0, 0], outTangent: [0, 0] });
    const paths = [
      vector.createDefaultBezierPath(),
      {
        closed: true,
        vertices: [
          [-1, -1],
          [1, -1],
          [0.2, 0],
          [1, 1],
          [-1, 1],
        ].map(vertex),
      },
      {
        closed: true,
        vertices: [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ].map(vertex),
      },
      {
        closed: false,
        vertices: [
          [0, 0],
          [0, 0],
          [1e-5, 0],
          [1, 0],
          [1, 1],
        ].map(vertex),
      },
      { closed: false, vertices: [] },
      { closed: true, vertices: [vertex([0.2, -0.7])] },
    ];
    for (const path of paths)
      for (const lineJoin of ["miter", "bevel", "round"]) {
        const shape = {
          kind: "bezier",
          path,
          roundness: 0,
          strokeWidth: 12,
          strokeColor: [1, 0.2, 0.5, 0.7],
          fillMode: "solid",
          gradientColor: [0, 0, 0, 1],
          gradientAngle: 0,
          dashLength: 0,
          dashGap: 0,
          lineCap: "round",
          lineJoin,
        };
        for (const trim of [
          { start: 0, end: 100, offset: 0 },
          { start: 75, end: 25, offset: 0 },
          { start: 10, end: 50, offset: -20 },
          { start: 50, end: 50, offset: 200 },
        ])
          await capture({ ...shape, trim }, undefined, [240, 100], [0, 0.5, 1]);
      }
    const polylines = [];
    for (const points of [
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      [
        [0, 0],
        [10, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [10, 0],
        [10, -10],
      ],
      [
        [0, 0],
        [0, 0],
        [0.00001, 0],
        [10, 0],
      ],
    ])
      for (const closed of [false, true]) {
        const trims = [];
        for (const [start, end, offset] of [
          [0, 1, 0],
          [0.25, 0.75, 0],
          [0.75, 0.25, 0],
          [0.2, 0.2, 0],
          [0, 0.3, 0.9],
          [-2, 2, -1.3],
        ])
          trims.push({
            start,
            end,
            offset,
            value: vector.trimPolyline(points, closed, start, end, offset),
          });
        const strokes = [];
        for (const width of [0, 0.2, 12])
          for (const join of ["miter", "bevel", "round"])
            for (const cap of ["butt", "round"])
              strokes.push({
                width,
                join,
                cap,
                value: vector.tessellateStroke(points, width, closed, join, cap),
              });
        polylines.push({
          points,
          closed,
          trims,
          strokes,
          triangles: vector.triangulatePolygon(points),
        });
      }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
      );
    const path = join(output, "path-oracle.json");
    await writeAtomicJson(path, { version: 1, sources, cases, polylines });
    return {
      output: local(path),
      sha256: sha256(await readFile(path)),
      cases: cases.length,
      samples,
      corpus_paths: seen.size,
      polylines: polylines.length,
    };
  } finally {
    await server.close();
  }
}
