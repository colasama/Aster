import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureClonerOracle(root, output, projectInputs) {
  const sources = await Promise.all(
    ["src/core/scene/cloner.ts", "scripts/migration/native-cloner-oracle.mjs"].map(
      async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) }),
    ),
  );
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const runtime = await server.ssrLoadModule("/src/core/scene/cloner.ts");
    const cases = [],
      invalid = [],
      seen = new Set();
    const transform = {
      position: [12, -24, 8],
      rotation: [31, -27, 87],
      scale: [-120, 75, 210],
      anchor: [19, 11, 23],
      opacity: 0.37,
    };
    function capture(settings) {
      const key = JSON.stringify(settings);
      if (seen.has(key)) return;
      seen.add(key);
      runtime.validateClonerSettings(settings);
      const spectra = [
        null,
        Array.from(
          new Float32Array([
            0, 0.7, 0, 0, 30, 0.15, 0, 0, 250, 0.75, 0, 0, 4000, 1.25, 0, 0, 16000, -1, 0, 0,
            192000, 1001, 0, 0,
          ]),
        ),
      ];
      const samples = spectra.map((spectrum, index) => {
        const time = index === 0 ? -1.25 : 7.125;
        const result = runtime.evaluateCloner(settings, time, {
          audioSpectrum: spectrum ? new Float32Array(spectrum) : undefined,
        });
        return {
          time,
          spectrum,
          instances: result.instances,
          data: Array.from(result.instanceData),
          composed: result.instances.map((i) => runtime.composeClonerTransform(transform, i)),
        };
      });
      cases.push({ settings, transform, samples });
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const composition of JSON.parse(bytes).compositions)
        for (const layer of composition.layers) if (layer.cloner) capture(layer.cloner);
    }
    const corpusCases = cases.length;
    const common = { id: "effector", enabled: true, strength: 0.75 };
    const effectors = [
      { ...common, kind: "position", value: [-13, 22, 0.3] },
      { ...common, kind: "rotation", value: [32, -75, 113] },
      { ...common, kind: "scale", value: [0.001, 275, 43] },
      {
        ...common,
        kind: "random",
        seed: 4294967295,
        position: [12, 31, 9],
        scale: [77, 91, 23],
        rotation: [11, 99, 43],
      },
      {
        ...common,
        kind: "audio",
        band: [30, 4000],
        gain: 1.75,
        position: [13, -25, 9],
        scale: [-140, 70, 30],
        rotation: [37, 95, -61],
      },
    ];
    const grid = { kind: "grid", count: [3, 2, 2], spacing: [-17, 0, 25] };
    capture({ distribution: grid, effectors: [] });
    for (const effector of effectors)
      for (const strength of [-10, 0, 0.25, 10])
        capture({ distribution: grid, effectors: [{ ...effector, strength }] });
    capture({ distribution: grid, effectors });
    capture({ distribution: grid, effectors: [...effectors].reverse() });
    capture({ distribution: grid, effectors: effectors.map((e) => ({ ...e, enabled: false })) });
    for (const axis of ["x", "y", "z"])
      for (const alignRotation of [false, true])
        for (const [count, startAngle, endAngle] of [
          [1, 47, 47],
          [7, 19, 199],
          [8, 30, 390],
          [9, 180, -360],
        ])
          capture({
            distribution: {
              kind: "radial",
              count,
              radius: 31,
              startAngle,
              endAngle,
              axis,
              alignRotation,
            },
            effectors,
          });
    capture({ distribution: { ...grid, count: [64, 32, 32] }, effectors: [] });
    for (const mutate of [
      (s) => (s.distribution.count = [512, 512, 512]),
      (s) => (s.distribution.count = [1.5, 1, 1]),
      (s) => (s.effectors = Array(33).fill(effectors[0])),
      (s) => (s.effectors[0].strength = 11),
      (s) => (s.effectors = [{ ...effectors[3], seed: -1 }]),
      (s) => (s.effectors = [{ ...effectors[4], band: [4000, 30] }]),
      (s) => (s.effectors = [{ ...effectors[2], value: [0, 100, 100] }]),
    ]) {
      const settings = structuredClone({ distribution: grid, effectors: [effectors[0]] });
      mutate(settings);
      assert.throws(() => runtime.validateClonerSettings(settings));
      invalid.push(settings);
    }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, { version: 1, sources, cases, invalid });
    return {
      cases: cases.length,
      corpus_cases: corpusCases,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      instances: cases.reduce(
        (n, c) => n + c.samples.reduce((m, s) => m + s.instances.length, 0),
        0,
      ),
      invalid_cases: invalid.length,
    };
  } finally {
    await server.close();
  }
}
