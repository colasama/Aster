import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureEffectInputOracle(root, output, projectInputs) {
  const paths = [
    "src/core/animation/timeline.ts",
    "src/core/animation/expressions.ts",
    "src/core/animation/beat-functions.ts",
    "src/renderer/effects/effect-program.ts",
    "src/renderer/effects/programs/effect-program-draw-generators.ts",
    "src/effects/registry.ts",
    "scripts/migration/native-effect-input-oracle.mjs",
  ];
  const sources = await Promise.all(
    paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  for (const entry of await readdir(join(root, "src/effects"), { recursive: true })) {
    const path = `src/effects/${entry.replaceAll("\\", "/")}`;
    if (!path.endsWith(".ts") || path.endsWith(".test.ts") || paths.includes(path)) continue;
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  }
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
    plugins: [
      {
        name: "oracle-private-effect-inputs",
        transform(code, id) {
          if (id.replaceAll("\\", "/").endsWith("/effects/effect-program.ts"))
            return `${code}\nexport { scalePixelParameters, colorChannels };`;
          if (id.replaceAll("\\", "/").endsWith("/programs/effect-program-draw-generators.ts"))
            return `${code}\nexport { gradientColor };`;
        },
      },
    ],
  });
  try {
    const timeline = await server.ssrLoadModule("/src/core/animation/timeline.ts");
    const runtime = await server.ssrLoadModule("/src/renderer/effects/effect-program.ts");
    const gradient = await server.ssrLoadModule(
      "/src/renderer/effects/programs/effect-program-draw-generators.ts",
    );
    const registry = await server.ssrLoadModule("/src/effects/registry.ts");
    const cases = [],
      seen = new Set();
    let state = 0xa57e9011;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    function capture(effect, times) {
      const definition = registry.EFFECT_BY_TYPE.get(effect.type);
      const defaults = new Map((definition?.parameters ?? []).map((p) => [p.key, p.defaultValue]));
      for (const key of [
        ...Object.keys(effect.parameters),
        ...Object.keys(effect.parameterKeyframes ?? {}),
        ...Object.keys(effect.parameterExpressions ?? {}),
      ])
        if (!defaults.has(key)) defaults.set(key, 0);
      defaults.set("missing-native-oracle-parameter", 17.25);
      const queries = [...defaults].flatMap(([key, fallback]) => [
        { key, fallback },
        { key, fallback: -3.75 },
      ]);
      const pixelParameters = (definition?.parameters ?? [])
        .filter((p) => p.unit === "px")
        .map(({ key, defaultValue }) => ({ key, defaultValue }));
      cases.push({
        effect,
        queries,
        pixelParameters,
        samples: times.map((time, i) => {
          const pixelScale = [1, 0.25, 1.3, 2, 4][i % 5];
          const scaled = runtime.scalePixelParameters(effect, time, pixelScale);
          const values = queries.map(({ key, fallback }) =>
            timeline.evaluateEffectParameter(effect, key, time, fallback),
          );
          const colors = values.map(runtime.colorChannels);
          const mask = effect.mask
            ? [
                ...runtime
                  .compileEffectProgram(
                    {},
                    time,
                    [{ effects: [{ ...effect, enabled: true, type: "exposure", parameters: {} }] }],
                    pixelScale,
                  )
                  .data.slice(1, 9),
              ]
            : null;
          return {
            time,
            pixelScale,
            values,
            colors,
            scaledValues: queries.map(({ key, fallback }) =>
              timeline.evaluateEffectParameter(scaled, key, time, fallback),
            ),
            gradientColors:
              effect.type === "multi-stop-gradient"
                ? [1, 2, 3, 4, 5].map((n) =>
                    gradient.gradientColor(effect, `color${n}`, time, 0x123456),
                  )
                : [],
            mask,
          };
        }),
      });
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const c of JSON.parse(bytes).compositions)
        for (const l of c.layers)
          for (const effect of l.effects) {
            const key = JSON.stringify(effect);
            if (seen.has(key)) continue;
            seen.add(key);
            capture(effect, [
              -1,
              0,
              c.duration,
              ...Array.from({ length: 64 }, () => random() * c.duration),
            ]);
          }
    }
    const keys = (a, b, interpolation = "linear") => [
      { id: "a", time: 0.25, value: a, interpolation, easing: [0.2, -1, 0.8, 2], spatialOut: 10 },
      { id: "b", time: 2, value: b, interpolation: "step", spatialIn: -5 },
    ];
    const base = {
      id: "synthetic",
      type: "gaussian-blur",
      name: "Effect",
      enabled: true,
      parameters: { radius: 12 },
    };
    const synthetic = [
      base,
      { ...base, parameters: {} },
      { ...base, parameterKeyframes: { radius: [] } },
      {
        ...base,
        parameterKeyframes: { radius: keys(0, 100) },
        parameterExpressions: { radius: "value * 2 + time" },
      },
      { ...base, parameterExpressions: { radius: "unknown(" } },
      { ...base, parameterExpressions: { radius: "1/(time-1)" } },
      { ...base, type: "unknown-effect", parameterExpressions: { radius: "time+value" } },
      { ...base, parameterKeyframes: { other: keys(100, -50, "bezier") } },
    ];
    for (const shape of ["ellipse", "rectangle", "path"])
      synthetic.push({
        ...base,
        mask: {
          shape,
          center: [-10, 130],
          size: [200, 75],
          feather: 24,
          opacity: 63,
          invert: true,
          ...(shape === "path" ? { pathId: "shared" } : {}),
        },
      });
    for (const interpolation of ["linear", "step", "bezier"])
      synthetic.push({
        ...base,
        type: "multi-stop-gradient",
        parameters: { color1: 0xff00ff, color2: -10, color3: 0x1000000, color4: 0.5, color5: 0 },
        parameterKeyframes: {
          color1: keys(0xff0000, 0x0000ff, interpolation),
          color2: keys(-100, 0x1ffffff, interpolation),
          color5: [],
        },
        parameterExpressions: { color1: "value + time*10000", color4: "123456" },
      });
    for (const effect of synthetic) capture(effect, [-1, 0, 0.25, 0.5, 1, 1.5, 2, 4]);
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
      corpus_effects: seen.size,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      parameter_samples: cases.reduce((n, c) => n + c.samples.length * c.queries.length, 0),
    };
  } finally {
    await server.close();
  }
}
