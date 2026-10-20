import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureExpressionOracle(root, output, projectInputs) {
  assert(projectInputs.length > 0, "Native expression coverage needs corpus projects");
  const sources = [];
  for (const path of [
    "src/core/animation/expressions.ts",
    "src/core/animation/beat-functions.ts",
    "src/core/animation/timeline.ts",
    "scripts/migration/native-expression-oracle.mjs",
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
    const { evaluateExpression, evaluateLayerTransform } = await server.ssrLoadModule(
      "/src/core/animation/expressions.ts",
    );
    const expressions = [
      "time",
      "value",
      "pi",
      "e",
      "TIME + VALUE",
      "2+3*4",
      "2^3^2",
      "-2^2",
      "2^-2",
      "-5%3",
      "5%-3",
      "1e-3 + .5 + 5.",
      "value + sin(time * pi) * 20",
      "clamp(pow(3,2),0,5)",
      "abs(value)",
      "ceil(value)",
      "cos(value)",
      "floor(value)",
      "round(value)",
      "sin(value)",
      "sqrt(value)",
      "tan(value)",
      "min(time,value,0)",
      "max(time,value,0)",
      "pow(value,2)",
      "clamp(value,10,-10)",
      "linear(value,0,2,-10,100)",
      "ease(value,0,2,-10,100)",
      "linear(value,1,1,5,10)",
      "ease(value,1,1,5,10)",
      "beat(150)",
      "beatphase(150)",
      "beat(150,0.4)",
      "beatphase(150,0.4,2)",
      "beat(-1)",
      "beat(120,0,0)",
      "beat(120,0,-1)",
      "beat(120,0,2,3)",
      "value + 10 * pow(1 - beatphase(120), 3)",
      "round(-0.5)",
      "round(-1.5)",
      "round(0.49999999999999994)",
      "round(4503599627370495.5)",
      "0^0",
      "(-1)^(1/0)",
      "1^(1/0)",
      "pow(-1,0.5)",
      "min(1,0/0)",
      "max(1,0/0)",
      "min(0,-0)",
      "max(-0,0)",
      "round(-0.2)",
      "-0%3",
      "sqrt(-1)",
      "clamp(0/0,0,1)",
      "ease(0/0,0,1,0,1)",
      "linear(0,0,1/0,0,1)",
      "1/0",
      "0/0",
      "",
      " ",
      "1..2",
      "1e",
      "1e+",
      "1e309",
      "1 2",
      "0x10",
      "Math.sin(1)",
      "globalThis.alert(1)",
      "time[0]",
      "time=2",
      "(()=>1)()",
      "sin()",
      "sin(1,2)",
      "min()",
      "max()",
      "pow(2)",
      "clamp(2,0)",
      "unknown(1)",
      "foo",
      "1+",
      "(1",
      "1)",
      "sin(1,)",
      "1**2",
      "1//2",
      "1&&2",
      "1<2",
      "1?2:3",
      "NaN",
      "Infinity",
      "constructor(1)",
      "toString(1)",
      "__proto__(1)",
      "\uFEFF1\u00A0+\u20281",
      "\u00851",
      "1".repeat(2049),
      `${"1+".repeat(300)}1`,
      `${"(".repeat(33)}1${")".repeat(33)}`,
      `${"(".repeat(31)}1${")".repeat(31)}`,
      `${"1+".repeat(255)}1`,
      `${"1+".repeat(254)}1`,
    ];

    const contexts = [
      { time: 0, value: 0 },
      { time: -1, value: -2.5 },
      { time: 0.5, value: 10 },
      { time: 2.5, value: 0.25 },
      { time: 10, value: 100 },
    ];
    const cases = [],
      corpusExpressions = new Set(),
      transforms = [];
    const record = (expression, context) => {
      try {
        const value = evaluateExpression(expression, context);
        cases.push({
          expression,
          context,
          accepted: true,
          value,
          negative_zero: Object.is(value, -0),
        });
      } catch {
        cases.push({ expression, context, accepted: false });
      }
    };
    function collect(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "expressions" || key === "parameterExpressions") {
          for (const expression of Object.values(child ?? {}))
            if (typeof expression === "string") corpusExpressions.add(expression);
        } else collect(child);
      }
    }
    let state = 0xa57e9004;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const transformSeen = new Set();
    for (const input of projectInputs) {
      const path = isAbsolute(input.path) ? input.path : join(root, input.path);
      const bytes = await readFile(path);
      assert.equal(sha256(bytes), input.sha256, "Expression project input changed");
      const project = JSON.parse(bytes);
      collect(project);
      for (const composition of project.compositions)
        for (const layer of composition.layers) {
          if (!layer.expressions || !Object.keys(layer.expressions).length) continue;
          const identity = JSON.stringify([layer.transform, layer.expressions]);
          if (transformSeen.has(identity)) continue;
          transformSeen.add(identity);
          const times = [
            -1,
            0,
            composition.duration,
            composition.duration + 1,
            ...Array.from({ length: 64 }, () => random() * composition.duration),
          ];
          transforms.push({
            transform: layer.transform,
            expressions: layer.expressions,
            samples: times.map((time) => ({ time, value: evaluateLayerTransform(layer, time) })),
          });
        }
    }
    for (const expression of expressions)
      for (const context of contexts) record(expression, context);
    for (const expression of corpusExpressions)
      for (let n = 0; n < 64; n++)
        record(expression, { time: random() * 60 - 1, value: random() * 2000 - 1000 });
    const scalar = (value) => ({ mode: "static", value });
    const transform = {
      position: [scalar(10), scalar(-2), scalar(0)],
      rotation: [scalar(0), scalar(0), scalar(0)],
      scale: [scalar(100), scalar(100), scalar(100)],
      anchor: [scalar(0), scalar(0), scalar(0)],
      opacity: scalar(120),
    };
    const layer = {
      transform,
      expressions: { "position.0": "value / time", "position.1": "nope(", opacity: "value - 100" },
    };
    transforms.push({
      ...layer,
      samples: [-1, 0, 0.5, 2].map((time) => ({
        time,
        value: evaluateLayerTransform(layer, time),
      })),
    });
    for (const source of sources)
      assert.equal(
        sha256(await readFile(join(root, source.path))),
        source.sha256,
        "Expression oracle source changed",
      );
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
        "Expression corpus input changed",
      );
    const result = {
      version: 1,
      sources,
      corpus_inputs: projectInputs,
      seed: 0xa57e9004,
      corpus_expressions: corpusExpressions.size,
      cases,
      transforms,
    };
    await writeAtomicJson(output, result);
    return {
      cases: cases.length,
      accepted: cases.filter((c) => c.accepted).length,
      rejected: cases.filter((c) => !c.accepted).length,
      corpus_expressions: corpusExpressions.size,
      transform_cases: transforms.length,
      transform_samples: transforms.reduce((s, t) => s + t.samples.length, 0),
    };
  } finally {
    await server.close();
  }
}
