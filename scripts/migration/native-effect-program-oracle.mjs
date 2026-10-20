import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureEffectProgramOracle(root, output, projectInputs) {
  const manifestPath = "crates/aster-eval/src/effects/program/source-manifest.json";
  const manifest = JSON.parse(await readFile(join(root, manifestPath)));
  const sources = [...manifest.sources];
  for (const path of [
    manifestPath,
    "src/core/animation/timeline.ts",
    "src/core/animation/expressions.ts",
    "src/core/animation/beat-functions.ts",
    "scripts/migration/native-effect-program-oracle.mjs",
  ])
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  for (const source of sources)
    assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const runtime = await server.ssrLoadModule("/src/renderer/effects/effect-program.ts");
    const registry = await server.ssrLoadModule("/src/effects/registry.ts");
    const categories = new Set(["Color Correction", "Channel", "Keying", "Matte", "Looks"]);
    if (manifest.phase !== "color")
      for (const category of ["Blur & Sharpen", "Distort", "Transform", "Perspective"])
        categories.add(category);
    const types = registry.EFFECT_REGISTRY.filter(
      (e) =>
        manifest.phase === "all" ||
        categories.has(e.category) ||
        (manifest.phase !== "color" && ["glow", "bloom"].includes(e.type)),
    ).map((e) => e.type);
    assert.deepEqual(
      [...manifest.supported].sort(),
      types.sort(),
      "Every declared effect family must be implemented",
    );
    const accepted = new Set(types),
      seen = new Set(),
      deferred = new Set(),
      cases = [];
    let state = 0xa57e9012;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    function capture(layers, times, expectedNativeError = false) {
      cases.push({
        layers,
        expectedNativeError,
        samples: times.map((time, i) => {
          const pixelScale = [1, 0.35, 1.4, 2, 4][i % 5];
          const program = runtime.compileEffectProgram({}, time, layers, pixelScale);
          const bits = [
            ...new Uint32Array(program.data.buffer, program.data.byteOffset, program.count * 16),
          ];
          return {
            time,
            pixelScale,
            bits,
            count: program.count,
            usesBlur: program.usesBlur,
            usesGlow: program.usesGlow,
            glowThreshold: program.glowThreshold,
          };
        }),
      });
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const composition of JSON.parse(bytes).compositions) {
        const layers = composition.layers
          .map((layer) => ({
            effects: layer.effects.filter((e) => {
              if (!accepted.has(e.type)) {
                deferred.add(e.type);
                return false;
              }
              return true;
            }),
          }))
          .filter((layer) => layer.effects.length);
        if (!layers.length) continue;
        const key = JSON.stringify(layers);
        if (seen.has(key)) continue;
        seen.add(key);
        capture(layers, [
          -1,
          0,
          composition.duration,
          ...Array.from({ length: 64 }, () => random() * composition.duration),
        ]);
      }
    }
    for (const definition of registry.EFFECT_REGISTRY.filter((d) => accepted.has(d.type))) {
      const base = {
        id: "effect",
        type: definition.type,
        name: "Effect",
        enabled: true,
        parameters: Object.fromEntries(definition.parameters.map((p) => [p.key, p.defaultValue])),
      };
      capture([{ effects: [base] }], [-1, 0, 0.5, 1, 2]);
      capture([{ effects: [{ ...base, parameters: {} }] }], [0, 1]);
      const animated = {
        ...structuredClone(base),
        parameterKeyframes: {},
        parameterExpressions: {},
        mask: {
          shape: "rectangle",
          center: [37, 65],
          size: [45, 120],
          feather: 18,
          opacity: 74,
          invert: true,
        },
      };
      for (const [i, p] of definition.parameters.entries()) {
        const a = p.defaultValue,
          b = a + (i % 2 ? -0.75 : 1.25);
        animated.parameterKeyframes[p.key] = [
          {
            id: "a",
            time: 0.1,
            value: a,
            interpolation: "bezier",
            easing: [0.25, -0.25, 0.75, 1.25],
          },
          { id: "b", time: 1.5, value: b, interpolation: "linear" },
        ];
        animated.parameterExpressions[p.key] = i % 3 ? "value + time * 0.13" : "missing(";
      }
      capture([{ effects: [animated] }], [-1, 0.1, 0.37, 0.83, 1.5, 3]);
    }
    const effect = (type, parameters = {}) => ({
      id: type,
      type,
      name: type,
      enabled: true,
      parameters,
    });
    const mask = {
      shape: "ellipse",
      center: [50, 50],
      size: [100, 100],
      feather: 10,
      opacity: 50,
      invert: false,
    };
    capture(
      [
        { effects: [effect("exposure", { exposure: 1 })] },
        { effects: [effect("tint", { amount: 23 }), { ...effect("fill"), mask }] },
      ],
      [0, 1],
    );
    capture(
      [
        {
          effects: Array.from({ length: 70 }, (_, i) => ({
            ...effect("exposure", { exposure: i }),
            ...(i % 2 ? { mask } : {}),
          })),
        },
      ],
      [0, 1],
    );
    capture(
      [{ effects: [effect("unknown-effect"), { ...effect("gaussian-blur"), enabled: false }] }],
      [0],
    );
    capture([], [0]);
    if (accepted.has("multi-stop-gradient")) {
      for (const positions of [
        [0, 0, 0],
        [100, 100, 100],
        [80, 20, 50],
        [-100, 250, -0],
      ]) {
        const gradient = effect("multi-stop-gradient", {
          position2: positions[0],
          position3: positions[1],
          position4: positions[2],
          color1: 0xff0000,
          color2: 0x00ff00,
          color3: 0x0000ff,
          color4: 0xffffff,
          color5: 0,
        });
        gradient.parameterKeyframes = {
          color1: [
            { id: "red", time: 0, value: 0xff0000, interpolation: "linear" },
            { id: "blue", time: 1, value: 0x0000ff, interpolation: "linear" },
          ],
        };
        gradient.parameterExpressions = { color1: "0" };
        capture([{ effects: [gradient] }], [0, 0.5, 1]);
      }
    }
    if (accepted.has("fast-bokeh")) {
      for (const irisShape of [-1, -0.5, 0, 0.5, 5.5, 6, 7, 100])
        for (const quality of [-1, 0, 2, 3])
          capture(
            [
              {
                effects: [
                  effect("fast-bokeh", { irisShape, quality, focusRange: -1, invertDepth: 0.5 }),
                ],
              },
            ],
            [0, 1],
          );
      capture(
        [{ effects: [effect("glow", { threshold: 0.7 }), effect("bloom", { threshold: 0.9 })] }],
        [0, 1],
      );
    }
    const unsupported = registry.EFFECT_REGISTRY.find((d) => !accepted.has(d.type));
    if (unsupported) capture([{ effects: [effect(unsupported.type)] }], [0], true);
    const lut = effect("lut", { intensity: 72 });
    lut.resource = {
      kind: "lut3d",
      name: "Identity",
      size: 1,
      checksum: "12345678",
      data: [0, 0, 0],
      domainMin: [-0.2, 0.1, 0.3],
      domainMax: [1.4, 1.3, 1.2],
    };
    capture([{ effects: [lut] }], [0]);
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
      );
    await writeAtomicJson(output, {
      version: 1,
      sources,
      supported: types,
      deferred: [...deferred].sort(),
      cases,
    });
    return {
      cases: cases.length,
      corpus_stacks: seen.size,
      effect_types: types.length,
      deferred_types: [...deferred].sort(),
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
    };
  } finally {
    await server.close();
  }
}
