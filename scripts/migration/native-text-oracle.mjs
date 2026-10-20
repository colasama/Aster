import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { textExpressionFixtures, textFixtures } from "./native-text-fixtures.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureTextOracle(root, output, projectInputs) {
  const sources = [];
  for (const path of [
    "src/core/animation/text-animator-stack.ts",
    "src/core/animation/text-selectors.ts",
    "src/core/animation/text-selector-expression.ts",
    "src/core/animation/text-animator.ts",
    "src/core/animation/text-animator-groups.ts",
    "src/core/animation/beat-functions.ts",
    "src/core/animation/timeline.ts",
    "scripts/migration/native-text-oracle.mjs",
    "scripts/migration/native-text-fixtures.mjs",
  ])
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  for (const path of [
    "src/renderer/text/text-motion-blur-plan.ts",
    "src/renderer/text/text-rasterizer.ts",
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
    const stack = await server.ssrLoadModule("/src/core/animation/text-animator-stack.ts");
    const expr = await server.ssrLoadModule("/src/core/animation/text-selector-expression.ts");
    const temporal = await server.ssrLoadModule("/src/core/animation/text-animator.ts");
    const selector = await server.ssrLoadModule("/src/core/animation/text-selectors.ts");
    const motion = await server.ssrLoadModule("/src/renderer/text/text-motion-blur-plan.ts");
    const template = JSON.parse(
      await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
    );
    const cases = [],
      seen = new Set(),
      expressionSources = new Set(textExpressionFixtures());
    let state = 0xa57e9010;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    function capture(settings, text, times, sourceLayer) {
      const layer = sourceLayer ?? {
        ...structuredClone(template.compositions[0].layers[0]),
        kind: "text",
        text,
        textAnimator: settings,
      };
      const units = stack.segmentTextLayoutUnits(text);
      for (const g of settings.groups)
        for (const s of g.selectors)
          if (s.kind === "expression") expressionSources.add(s.expression);
      const baseStyles = units.map((u, i) => ({
        codePoint: u.codePoint,
        ...(i % 3
          ? {
              fillColor: [0.1, 0.8, 0.3, 0.9],
              strokeColor: [0.2, 0.3, 0.9, 0.4],
              strokeWidth: 3,
              opacity: 0.7,
            }
          : {}),
      }));
      cases.push({
        layer,
        settings,
        units,
        baseStyles,
        samples: times.map((time, index) => {
          const expressionsEnabled = index % 3 !== 0;
          const options = {
            time,
            ...(expressionsEnabled
              ? { evaluateExpression: expr.safeEvaluateTextSelectorExpression }
              : {}),
          };
          const closeTime = time + 0.07,
            resolutionScale = [-1, 1, 1.25, 1.26, 2, 7, 9][index % 7];
          return {
            time,
            expressionsEnabled,
            cacheTime: temporal.clampTextAnimationTime(settings, time) ?? null,
            closeTime,
            resolutionScale,
            travel: motion.estimateTextAnimatorPixelTravel(layer, time, closeTime, resolutionScale),
            characters: units.map((unit, i) =>
              stack.evaluateTextAnimatorStack(settings.enabled ? settings.groups : [], unit, {
                ...options,
                baseStyle: baseStyles[i],
              }),
            ),
            selectors: settings.groups.map((group) =>
              units.map((unit) =>
                selector.evaluateTextSelectors(group.selectors, unit, {
                  ...options,
                  animatorSeed: group.randomSeed,
                }),
              ),
            ),
          };
        }),
      });
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      for (const c of JSON.parse(bytes).compositions)
        for (const l of c.layers) {
          if (!l.textAnimator) continue;
          const key = JSON.stringify([l.textAnimator, l.text ?? l.name]);
          if (seen.has(key)) continue;
          seen.add(key);
          capture(
            l.textAnimator,
            l.text ?? l.name,
            [-1, 0, c.duration, ...Array.from({ length: 64 }, () => random() * c.duration)],
            l,
          );
        }
    }
    for (const settings of textFixtures())
      capture(settings, "Az 09!é中 é👩‍💻\nTwo\r\nZ", [-2, 0, 0.25, 0.5, 1, 2, 4]);
    const expressions = [...expressionSources].map((source) => ({
      source,
      samples: Array.from({ length: 12 }, (_, i) => {
        const context = {
          time: i / 3 - 2,
          textIndex: i,
          textTotal: i % 4 ? 12 : 0,
          selectorValue: i * 19 - 100,
        };
        let value = null,
          error = false;
        try {
          value = expr.evaluateTextSelectorExpression(source, context);
        } catch {
          error = true;
        }
        return {
          context,
          error,
          value,
          fallback: expr.safeEvaluateTextSelectorExpression(source, context),
        };
      }),
    }));
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    for (const input of projectInputs)
      assert.equal(
        sha256(await readFile(isAbsolute(input.path) ? input.path : join(root, input.path))),
        input.sha256,
      );
    await writeAtomicJson(output, { version: 1, sources, template, cases, expressions });
    return {
      cases: cases.length,
      corpus_stacks: seen.size,
      expressions: expressions.length,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      character_samples: cases.reduce((n, c) => n + c.samples.length * c.units.length, 0),
    };
  } finally {
    await server.close();
  }
}
