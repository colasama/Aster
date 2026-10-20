import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { textFixtures } from "./native-text-fixtures.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureTextExposureOracle(root, output, projectInputs) {
  const sources = await Promise.all(
    [
      "scripts/migration/native-text-exposure-oracle.mjs",
      "scripts/migration/native-text-fixtures.mjs",
      "src/renderer/text/text-motion-blur-plan.ts",
      "src/core/animation/motion-blur.ts",
      "src/core/animation/text-animator.ts",
      "src/core/animation/text-animator-stack.ts",
      "src/core/animation/text-selector-expression.ts",
      "src/core/animation/layer-time.ts",
      "src/core/scene/scene-evaluation.ts",
      "src/renderer/frame-plan/temporal-text-plan.ts",
      "src/renderer/frame-plan/temporal-pass-plan.ts",
      "src/renderer/text/text-motion-blur-pass-plan.ts",
    ].map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { planTextMotionBlurFrame } = await server.ssrLoadModule(
      "/src/renderer/text/text-motion-blur-plan.ts",
    );
    const { flattenSceneLayers } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { segmentTextLayoutUnits } = await server.ssrLoadModule(
      "/src/core/animation/text-animator-stack.ts",
    );
    const { buildTemporalTextPlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/temporal-text-plan.ts",
    );
    const { buildTemporalPassSlice } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/temporal-pass-plan.ts",
    );
    const cases = [];
    const scene = (s) => ({
      layerId: s.layer.id,
      sourceCompositionId: s.sourceComposition.id,
      transform: s.transform,
      localTime: s.localTime,
      instanceId: s.instanceId,
      resourceInstanceId: s.resourceInstanceId,
      selectionId: s.selectionId,
      ...(s.precompositionSurface
        ? {
            precompositionSurface: {
              compositionId: s.precompositionSurface.composition.id,
              time: s.precompositionSurface.time,
              compositionPath: s.precompositionSurface.compositionPath,
            },
          }
        : {}),
    });
    function capture(project, composition, times, input = project) {
      const layouts = Object.fromEntries(
        project.compositions.map((c) => [
          c.id,
          Object.fromEntries(
            c.layers
              .filter((l) => l.kind === "text")
              .map((l) => [l.id, segmentTextLayoutUnits(l.text ?? l.name)]),
          ),
        ]),
      );
      cases.push({
        project: input,
        layouts,
        samples: times.map((time, i) => {
          const request = {
            locale: new Intl.Collator().resolvedOptions().locale,
            compositionId: composition.id,
            time,
            resolutionScale: [1, 2, 4][i % 3],
          };
          const result = planTextMotionBlurFrame({
            composition,
            project,
            frameTime: time,
            sceneLayers: flattenSceneLayers(composition, project, time),
            resolutionScale: request.resolutionScale,
          });
          const header = {
            snapshot: { snapshotScope: "native-text-exposure", projectRevision: 17 },
            compositionId: composition.id,
            time,
            frameRate: composition.frameRate,
            target: { width: 320, height: 180 },
            renderTarget: { width: 320, height: 180 },
            antiAliasing: "off",
          };
          const plans = Object.fromEntries(result.plans);
          const exposure = new Set(result.exposureSceneLayers.map((s) => s.resourceInstanceId));
          const slices = Object.fromEntries(
            [...result.plans].map(([id, p]) => {
              const v = buildTemporalTextPlan(header, id, p, exposure.has(id));
              return [id, { metadata: v.metadata, blobs: v.blobs.map((b) => Array.from(b)) }];
            }),
          );
          return {
            request,
            expected: {
              sampleCount: result.sampleCount,
              plans,
              exposureSceneLayers: result.exposureSceneLayers.map(scene),
              renderSceneLayers: result.renderSceneLayers.map(scene),
            },
            slices,
          };
        }),
      });
    }
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      const project = JSON.parse(bytes);
      for (const c of project.compositions)
        if (c.motionBlur?.enabled)
          capture(project, c, [0, 0.125, c.duration / 2, c.duration], input);
    }
    const template = JSON.parse(
      await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
    );
    for (const [index, settings] of textFixtures().entries()) {
      const project = structuredClone(template),
        c = project.compositions[0];
      project.compositions = [c];
      project.sources = [];
      project.fonts = [];
      c.id = `text-exposure-${index}`;
      c.duration = 4;
      c.motionBlur = {
        enabled: true,
        shutterAngle: 720,
        shutterPhase: -360,
        samplesPerFrame: 8,
        adaptiveSampleLimit: 32,
      };
      const base = {
        ...c.layers[0],
        id: "animated",
        name: "Animated",
        kind: "text",
        text: "Az 09!é中 é👩‍💻",
        textAnimator: settings,
        motionBlur: true,
        inPoint: 0,
        outPoint: 4,
      };
      c.layers = [
        base,
        { ...structuredClone(base), id: "exposure-only", inPoint: 1.001, outPoint: 1.009 },
        { ...structuredClone(base), id: "held", timeRemap: { mode: "static", value: 0.6 } },
        {
          ...structuredClone(base),
          id: "offset",
          timeOffset: 0.2,
          timeStretch: 2,
          inPoint: 0.25,
          outPoint: 2,
        },
      ];
      capture(project, c, [0.25, 0.999, 1, 1.009, 2]);
    }
    assert(cases.length > 5);
    // Real nested siblings can share both the selection and shutter-order keys.
    const nested = structuredClone(
      cases.find((c) => Object.keys(c.samples[2].slices).length).project,
    );
    const child = nested.compositions[0],
      rootComposition = structuredClone(child);
    rootComposition.id = "nested-text-root";
    rootComposition.layers = [
      {
        ...structuredClone(child.layers[0]),
        id: "wrapper",
        kind: "precomposition",
        sourceCompositionId: child.id,
        effects: [],
      },
    ];
    child.layers = [
      { ...child.layers[0], id: "é", inPoint: 1.001, outPoint: 1.009 },
      { ...child.layers[0], id: "Z", inPoint: 0, outPoint: 4 },
    ];
    nested.compositions = [rootComposition, child];
    capture(nested, rootComposition, [0.999, 1, 1.009]);
    const identities = [
      "root/Z",
      "root/a",
      "root/A",
      "root/ä",
      "root/é",
      "root/é",
      "root/中",
      "root/阿",
      "root/🙂",
      "root/-",
      "root/_",
      "root/10",
      "root/2",
    ];
    const collations = ["en-US", "zh-CN", "ja-JP", "sv-SE", "de-DE", "tr-TR"].map((locale) => ({
      locale,
      identities,
      expected: [...identities].sort(new Intl.Collator(locale).compare),
    }));
    const header = Object.values(
      cases.flatMap((c) => c.samples).find((s) => Object.keys(s.slices).length).slices,
    )[0].metadata.header;
    const rasterPasses = [];
    const addRaster = (input) => {
      let expected = null,
        error = false;
      try {
        const p = buildTemporalPassSlice(header, {
          ...input,
          kind: "temporal_text_passes",
          sample_format: "rgba8unorm-srgb",
          accumulation_format: "rgba16float",
          output_format: "rgba8unorm-srgb",
        });
        expected = { metadata: p.metadata, blobs: p.blobs.map((b) => Array.from(b)) };
      } catch {
        error = true;
      }
      rasterPasses.push({ header, input, expected, error });
    };
    const raster = (weights) => ({
      width: 64,
      height: 32,
      output: sha256(Buffer.from("output")),
      samples: weights.map((weight, index) => ({
        hash: sha256(Buffer.from(String(index))),
        weight,
      })),
    });
    for (const weights of [
      [],
      [1],
      [0.125, 0.375],
      [0, Number.MIN_VALUE, 1 / 3],
      [0.5, 0.5 + Number.EPSILON],
      ...Array.from({ length: 7 }, (_, i) =>
        Array.from({ length: 2 ** (i + 6) }, () => 1 / 2 ** (i + 6)),
      ),
    ])
      addRaster(raster(weights));
    for (const invalid of [
      raster([-0.1]),
      raster([1.1]),
      raster([0.6, 0.6]),
      raster(Array.from({ length: 4097 }, () => 0)),
      { ...raster([]), width: 0 },
      { ...raster([]), height: 8193 },
      { ...raster([1]), output: sha256(Buffer.from("0")) },
      {
        ...raster([0.5, 0.5]),
        samples: Array.from({ length: 2 }, () => ({
          hash: sha256(Buffer.from("same")),
          weight: 0.5,
        })),
      },
    ])
      addRaster(invalid);
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, { version: 1, sources, cases, collations, rasterPasses });
    return {
      raster_passes: rasterPasses.length,
      cases: cases.length,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      plans: cases.reduce(
        (n, c) => n + c.samples.reduce((v, s) => v + Object.keys(s.slices).length, 0),
        0,
      ),
      scope: "native-text-exposure-with-supplied-layout",
      whole_project_plan_parity: false,
    };
  } finally {
    await server.close();
  }
}
