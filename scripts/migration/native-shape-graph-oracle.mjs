import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureShapeGraphOracle(root, output, projectInputs) {
  const sources = [];
  for (const path of [
    "src/core/layers/shape-graph.ts",
    "src/core/animation/timeline.ts",
    "scripts/migration/native-shape-graph-oracle.mjs",
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
    const runtime = await server.ssrLoadModule("/src/core/layers/shape-graph.ts");
    const cases = [],
      seen = new Set();
    let state = 0xa57e9009;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    function capture(layer, times) {
      let samples = [],
        error = false;
      try {
        samples = times.map((time) => ({
          time,
          shapes: runtime.flattenShapeGraph(layer.shapeGraph, time),
          masks: runtime.resolveMaskPathReferences(layer, layer.shapeGraph),
        }));
      } catch {
        error = true;
      }
      cases.push({ layer, error, samples });
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const composition of JSON.parse(bytes).compositions)
        for (const layer of composition.layers) {
          if (!layer.shapeGraph) continue;
          const key = JSON.stringify([layer.shapeGraph, layer.effects]);
          if (seen.has(key)) continue;
          seen.add(key);
          capture(layer, [
            0,
            composition.duration,
            ...Array.from({ length: 64 }, () => random() * composition.duration),
          ]);
        }
    }
    const original = JSON.parse(
      await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
    ).compositions[0].layers[0];
    const scalar = (value) => ({ mode: "static", value });
    const transform = (x = 0, y = 0) => ({
      position: [scalar(x), scalar(y)],
      scale: [scalar(100), scalar(100)],
      rotation: scalar(0),
      opacity: scalar(100),
    });
    const path = {
      closed: true,
      vertices: [
        [0, 0],
        [1, 0],
        [0, 1],
      ].map((position) => ({ position, inTangent: [0, 0], outTangent: [0, 0] })),
    };
    const graph = {
      id: "graph",
      revision: 1,
      paths: [{ id: "shared", revision: 1, path }],
      groups: [
        {
          id: "root",
          name: "Root",
          visible: true,
          transform: transform(10, 0),
          children: [
            { kind: "path", id: "before", pathId: "shared", visible: true },
            { kind: "group", id: "reference", groupId: "nested" },
            { kind: "path", id: "after", pathId: "shared", visible: true },
          ],
        },
        {
          id: "nested",
          name: "Nested",
          visible: true,
          transform: transform(20, 5),
          children: [
            {
              kind: "path",
              id: "inside",
              pathId: "shared",
              visible: true,
              transform: transform(3, -9),
            },
          ],
        },
      ],
      rootGroupIds: ["root"],
    };
    function layer(edit) {
      const layer = {
        ...structuredClone(original),
        shapeGraph: structuredClone(graph),
        effects: [
          {
            id: "mask",
            type: "test",
            name: "Mask",
            enabled: false,
            parameters: {},
            mask: {
              shape: "path",
              pathId: "shared",
              center: [0, 0],
              size: [100, 100],
              feather: 5000000,
              opacity: -12,
              invert: true,
            },
          },
        ],
      };
      edit(layer);
      return layer;
    }
    const edits = [
      () => {},
      (l) => {
        l.shapeGraph.groups[0].transform.scale[0] = scalar(-120);
        l.shapeGraph.groups[1].transform.rotation = scalar(33);
      },
      (l) => {
        l.shapeGraph.groups[1].visible = false;
      },
      (l) => {
        l.shapeGraph.groups[1].children[0].visible = false;
      },
      (l) => {
        l.shapeGraph.rootGroupIds = ["nested", "root"];
      },
      (l) => {
        l.shapeGraph.groups[0].transform.rotation = {
          mode: "animated",
          keyframes: [
            { id: "duplicate", time: -1, value: -15, interpolation: "linear" },
            {
              id: "duplicate",
              time: 2,
              value: 350,
              interpolation: "bezier",
              easing: [0.3, -1, 0.8, 2],
            },
          ],
        };
      },
      (l) => {
        l.shapeGraph.groups[1].children.push({ kind: "group", id: "back", groupId: "root" });
      },
      (l) => {
        l.shapeGraph.rootGroupIds.push("missing");
      },
      (l) => {
        l.shapeGraph.groups[1].children[0].pathId = "missing";
      },
      (l) => {
        l.shapeGraph.groups[0].children.push(structuredClone(l.shapeGraph.groups[0].children[0]));
      },
      (l) => {
        l.shapeGraph.groups[1].children[0].transform = null;
      },
      (l) => {
        l.shapeGraph.paths[0].path.vertices = Array.from({ length: 513 }, () =>
          structuredClone(path.vertices[0]),
        );
      },
      (l) => {
        l.shapeGraph.id = "😀".repeat(129);
      },
      (l) => {
        l.shapeGraph.groups = Array.from({ length: 65 }, (_, i) => ({
          id: `g${i}`,
          name: "G",
          visible: true,
          transform: transform(),
          children: i < 64 ? [{ kind: "group", id: `ref${i}`, groupId: `g${i + 1}` }] : [],
        }));
        l.shapeGraph.rootGroupIds = ["g0"];
      },
    ];
    for (const edit of edits) capture(layer(edit), [-2, -1, 0, 0.5, 1, 2, 4]);
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
      );
    await writeAtomicJson(output, { version: 1, sources, cases });
    return {
      cases: cases.length,
      corpus_graphs: seen.size,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      rejected: cases.filter((c) => c.error).length,
    };
  } finally {
    await server.close();
  }
}
