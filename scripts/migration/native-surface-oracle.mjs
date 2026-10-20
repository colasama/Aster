import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { textFixtures } from "./native-text-fixtures.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureSurfaceOracle(root, output, projectInputs) {
  const sources = await Promise.all(
    [
      "scripts/migration/native-surface-oracle.mjs",
      "src/renderer/compositing/precomposition-scene-media.ts",
      "src/renderer/frame-plan/bundle-effect-records.ts",
      "src/renderer/scene/scene-generator-plan.ts",
      "src/renderer/scene/bundled-particle-generator.ts",
      "src/renderer/scene/scene-generator-program.ts",
      "src/renderer/scene/scene-generator-abi.ts",
      "src/renderer/scene/scene-generator-capacity.ts",
      "src/core/scene/scene-generator-registry.ts",
      "src/renderer/frame-plan/generator-plan.ts",
      "src/renderer/frame-plan/precomposition-bundle-resources.ts",
      "shaders/manifest.json",
      "shaders/scene/particle-compute-layout.wgsl",
      "shaders/scene/particle-compute-functions.wgsl",
      "shaders/scene/particle-render-layout.wgsl",
      "shaders/scene/particle-render-functions.wgsl",
      "shaders/scene/particle-projection.wgsl",
      "scripts/migration/native-text-fixtures.mjs",
      "src/renderer/text/text-motion-blur-plan.ts",
      "src/core/animation/text-animator-stack.ts",
      "src/renderer/compositing/precomposition-source-evaluation.ts",
      "src/renderer/compositing/precomposition-surface-plan.ts",
      "src/core/scene/scene-evaluation.ts",
      "src/core/scene/cloner.ts",
      "src/core/animation/layer-time.ts",
      "src/renderer/compositing/layer-composite.ts",
      "src/renderer/compositing/precomposition-scene-plan.ts",
      "src/renderer/frame-plan/precomposition-graph-plan.ts",
      "src/renderer/frame-plan/root-scene-plan.ts",
      "src/renderer/effects/layer-effect-plan.ts",
      "src/renderer/effects/effect-fusion.ts",
      "src/effects/registry.ts",
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
    const { flattenSceneLayers } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { evaluatePrecompositionSources, evaluatePrecompositionGeometry } =
      await server.ssrLoadModule("/src/renderer/compositing/precomposition-source-evaluation.ts");
    const { buildPrecompositionScenePlan } = await server.ssrLoadModule(
      "/src/renderer/compositing/precomposition-scene-plan.ts",
    );
    const { buildPrecompositionGraph } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/precomposition-graph-plan.ts",
    );
    const { buildRootScenePlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-scene-plan.ts",
    );
    const { buildFrameHeader } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-post-plan.ts",
    );
    const { prepareLayerEffects } = await server.ssrLoadModule(
      "/src/renderer/effects/layer-effect-plan.ts",
    );
    const { LutSelectionPlanner } = await server.ssrLoadModule(
      "/src/renderer/media/lut-selection-plan.ts",
    );
    const cases = [];
    const { segmentTextLayoutUnits } = await server.ssrLoadModule(
      "/src/core/animation/text-animator-stack.ts",
    );
    let activeInput;
    const bytesPlan = (p) => ({ metadata: p.metadata, blobs: p.blobs.map((b) => Array.from(b)) });
    const floatsPlan = (p) => ({
      metadata: p.metadata,
      floats: Array.from(
        new Float32Array(p.blobs[0].buffer, p.blobs[0].byteOffset, p.blobs[0].byteLength / 4),
      ),
    });
    const { bundledParticleDefinition } = await server.ssrLoadModule(
      "/src/renderer/scene/bundled-particle-generator.ts",
    );
    const { SceneGeneratorPlanner } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-generator-plan.ts",
    );
    const { createSceneGeneratorInstance } = await server.ssrLoadModule(
      "/src/core/scene/scene-generator-registry.ts",
    );
    const { bindPrecompositionSceneMedia } = await server.ssrLoadModule(
      "/src/renderer/compositing/precomposition-scene-media.ts",
    );
    const { buildBundleEffects } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/bundle-effect-records.ts",
    );
    const { PrecompositionBundleResources } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/precomposition-bundle-resources.ts",
    );
    const { shaderSources, ...generatorDefinition } = bundledParticleDefinition;
    const generatorSource = {
      pluginName: bundledParticleDefinition.pluginName,
      runtimeKey: bundledParticleDefinition.runtimeKey,
      shaderSources,
    };
    const resourceSummary = (r) => ({
      message: r.message,
      byte_length: r.bytes.length,
      payload_sha256: sha256(r.bytes),
    });
    function framePlans(prepared, composition, time, request) {
      const header = buildFrameHeader({
        snapshot: { snapshotScope: "native-surface-producer", projectRevision: request.revision },
        compositionId: composition.id,
        time,
        frameRate: composition.frameRate,
        target: { width: 320, height: 180 },
        renderTarget: { width: 320, height: 180 },
        antiAliasing: "off",
      });
      const frames = [],
        nodes = [],
        media = {};
      for (const operation of prepared.operations) {
        if (operation.kind !== "scene") continue;
        const source = operation.source,
          geometry = evaluatePrecompositionGeometry(source, () => undefined);
        const childHeader = buildFrameHeader({
          snapshot: { snapshotScope: "precomposition-scenes", projectRevision: request.revision },
          compositionId: source.composition.id,
          time: source.time,
          frameRate: source.composition.frameRate,
          target: { width: source.composition.width, height: source.composition.height },
          renderTarget: { width: source.target.width, height: source.target.height },
          antiAliasing: "off",
        });
        const effects = prepareLayerEffects({
          scene: source.layers,
          composition: source.composition,
          header: { ...childHeader, snapshot_scope: "precomposition-effects" },
          mipLevelCount: source.target.hasEffects
            ? Math.min(
                8,
                Math.floor(
                  Math.log2(
                    Math.max(
                      Math.ceil(source.target.width / 2),
                      Math.ceil(source.target.height / 2),
                    ),
                  ),
                ) + 1,
              )
            : 1,
          planner: new LutSelectionPlanner(),
          context: "precomposition",
        });
        const generatorDevice = {
          memoryBudgetMb: request.memoryBudgetMb ?? 512,
          storageByteLimit: 536870912,
          dispatchWorkgroupLimit: 65535,
        };
        const planner = new SceneGeneratorPlanner();
        const generators = source.layers
          .filter((s) => s.layer.kind === "generator")
          .map((scene) =>
            planner.prepare({
              scene,
              composition: source.composition,
              definition: bundledParticleDefinition,
              width: source.target.width,
              height: source.target.height,
              ...generatorDevice,
              camera: geometry.camera,
            }),
          );
        const scene = buildPrecompositionScenePlan({
          target: source.target,
          revision: request.revision,
          composition: source.composition,
          time: source.time,
          layers: source.layers,
          geometry: geometry.geometry,
          lighting: geometry.lighting,
          effects,
          generators,
          surfaceTargets: prepared.bindings,
        });
        const draws = scene.draws.map((draw) => {
          const batch = geometry.geometry.batches[draw.sceneDrawIndex];
          if (draw.texture.kind === "media")
            media[batch.instanceId] = sha256(Buffer.from(draw.texture.instanceId));
          return {
            instanceId: batch.instanceId,
            firstVertex: draw.firstVertex,
            vertexCount: draw.vertexCount,
            blendMode: "normal",
            texture:
              draw.texture.kind === "surface"
                ? draw.texture.targetId === null
                  ? { kind: "none" }
                  : { kind: "surface", instanceId: draw.texture.targetId }
                : draw.texture.kind === "media"
                  ? { kind: "media", hash: media[batch.instanceId] }
                  : draw.texture,
          };
        });
        const bound = bindPrecompositionSceneMedia(scene, {
          hashFor: (id) => sha256(Buffer.from(id)),
          bindingForHash: () => ({}),
        });
        const resources = new PrecompositionBundleResources();
        const records = buildBundleEffects(effects, resources);
        frames.push({
          programs: {
            label_utf16: Array.from({ length: source.composition.name.length }, (_, i) =>
              source.composition.name.charCodeAt(i),
            ),
            scene: floatsPlan(bound.scene),
            effects: records,
            resources: [...resources.used].sort().map((h) => resourceSummary(resources.resolve(h))),
            generators: scene.generators.map((g) => ({
              plan: bytesPlan(g.plan),
              resources: g.shaders.map(resourceSummary),
              origin: g.origin,
            })),
          },
          target: source.target,
          scene: floatsPlan(scene.scene),
          root: bytesPlan(buildRootScenePlan(childHeader, scene.commands, draws)),
          draw_scene_indices: scene.draws.map((d) => d.sceneDrawIndex),
        });
        nodes.push({
          target: source.target,
          drawTargets: scene.draws.map((d) =>
            d.texture.kind === "surface" ? d.texture.targetId : undefined,
          ),
        });
      }
      return {
        header,
        media,
        generatorDevice: {
          memoryBudgetMb: request.memoryBudgetMb ?? 512,
          storageByteLimit: 536870912,
          dispatchWorkgroupLimit: 65535,
        },
        expected: {
          graph: bytesPlan(buildPrecompositionGraph(header, nodes, prepared.bindings)),
          frames,
        },
      };
    }
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
    const owned = (r) => ({
      operations: r.operations.map((o) =>
        o.kind === "target"
          ? o
          : o.kind === "media"
            ? {
                kind: o.kind,
                scene: scene(o.scene),
                resolutionScale: o.resolutionScale,
                ...(o.textMotionBlur ? { textMotionBlur: o.textMotionBlur } : {}),
              }
            : {
                kind: o.kind,
                source: {
                  target: o.source.target,
                  compositionId: o.source.composition.id,
                  time: o.source.time,
                  layers: o.source.layers.map(scene),
                },
              },
      ),
      bindings: Object.fromEntries(r.bindings),
      activeKeys: [...r.activeKeys].sort(),
      diagnostics: r.diagnostics,
      budget: r.budget,
    });
    function capture(project, compositionId, times, requests, enableTextMotionBlur = false) {
      const composition = project.compositions.find((c) => c.id === compositionId),
        samples = [];
      for (const time of times)
        for (const request of requests) {
          let expected = null,
            error = false,
            frame = null;
          try {
            const prepared = evaluatePrecompositionSources({
              project,
              sceneLayers: flattenSceneLayers(composition, project, time),
              ...request,
              enableTextMotionBlur,
            });
            expected = owned(prepared);
            if ((cases.length < 48 || !activeInput) && time === times[0] && request.revision === 17)
              frame = framePlans(prepared, composition, time, request);
          } catch {
            error = true;
          }
          samples.push({ time, request, expected, error, frame });
        }
      const layouts = enableTextMotionBlur
        ? Object.fromEntries(
            project.compositions.map((c) => [
              c.id,
              Object.fromEntries(
                c.layers
                  .filter((l) => l.kind === "text")
                  .map((l) => [l.id, segmentTextLayoutUnits(l.text ?? l.name)]),
              ),
            ]),
          )
        : null;
      cases.push({
        project: activeInput ?? project,
        compositionId,
        samples,
        layouts,
        locale: new Intl.Collator().resolvedOptions().locale,
      });
    }
    const requests = [
      { revision: 17, maxTextureDimension: 16384, memoryBudgetMb: 512, renderScale: 1 },
      { revision: 18, maxTextureDimension: 1024, memoryBudgetMb: 32, renderScale: 1 },
      { revision: 19, maxTextureDimension: 16384, memoryBudgetMb: 512, renderScale: 2 },
      { revision: 20, maxTextureDimension: 64, memoryBudgetMb: 1, renderScale: 4 },
    ];
    let base;
    for (const input of projectInputs) {
      activeInput = input;
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      const project = JSON.parse(bytes);
      base ??= project;
      for (const composition of project.compositions)
        if (composition.layers.some((l) => l.kind === "precomposition"))
          capture(project, composition.id, [0.125, composition.duration / 2], requests);
    }
    activeInput = undefined;
    base = {
      schemaVersion: base.schemaVersion,
      id: base.id,
      name: base.name,
      activeCompositionId: base.activeCompositionId,
      compositions: [base.compositions[0]],
    };
    const template = base.compositions[0],
      layer = template.layers[0];
    const effect = {
      id: "tint",
      type: "color-overlay",
      name: "Tint",
      enabled: true,
      parameters: {},
    };
    function child(id, effects = false) {
      return {
        ...structuredClone(template),
        id,
        width: 32,
        height: 32,
        duration: 6,
        layers: [
          {
            ...structuredClone(layer),
            id: `${id}-solid`,
            kind: "solid",
            visible: true,
            solo: false,
            inPoint: 0,
            outPoint: 6,
            effects: effects ? [effect] : [],
          },
        ],
      };
    }
    function wrapper(id, target) {
      return {
        ...structuredClone(layer),
        id,
        kind: "precomposition",
        sourceCompositionId: target,
        visible: true,
        solo: false,
        inPoint: 0,
        outPoint: 6,
        timeOffset: 0,
        timeStretch: 1,
        effects: [effect],
      };
    }
    for (const effects of [false, true]) {
      const project = structuredClone(base),
        rootComp = child("surface-root");
      rootComp.layers = [];
      project.compositions = [rootComp];
      for (let i = 0; i < 12; i++) {
        const c = child(`child-${i}`, effects);
        project.compositions.push(c);
        rootComp.layers.push(wrapper(`wrapper-${i}`, c.id));
      }
      capture(project, rootComp.id, [0.125], requests);
    }
    for (const cycle of [false, true]) {
      const project = structuredClone(base);
      project.compositions = Array.from({ length: 7 }, (_, i) => child(`depth-${i}`));
      for (let i = 0; i < 6; i++)
        project.compositions[i].layers = [wrapper(`wrap-${i}`, project.compositions[i + 1].id)];
      if (cycle) project.compositions[2].layers = [wrapper("cycle", project.compositions[0].id)];
      capture(project, project.compositions[0].id, [0.125], requests);
    }
    const shared = structuredClone(base),
      rootComp = child("shared-root"),
      source = child("shared-source");
    rootComp.layers = [wrapper("first", source.id), wrapper("second", source.id)];
    shared.compositions = [rootComp, source];
    capture(shared, rootComp.id, [0, 0.5e-9, 1.5e-9, 2.5e-9, 1 / 3, 0.125], requests);
    const textProject = structuredClone(shared),
      textSource = textProject.compositions[1];
    textSource.motionBlur = {
      enabled: true,
      shutterAngle: 720,
      shutterPhase: -360,
      samplesPerFrame: 8,
      adaptiveSampleLimit: 32,
    };
    const textLayer = {
      ...textSource.layers[0],
      kind: "text",
      text: "Aé中",
      motionBlur: true,
      textAnimator: textFixtures()[0],
    };
    textSource.layers = [
      { ...textLayer, id: "é", inPoint: 1.001, outPoint: 1.009 },
      { ...textLayer, id: "Z", inPoint: 0, outPoint: 4 },
    ];
    capture(textProject, textProject.compositions[0].id, [0.999, 1, 1.009], requests, true);
    const generated = structuredClone(shared);
    const generatorLayer = {
      ...generated.compositions[1].layers[0],
      id: "nested-generator",
      kind: "generator",
      name: "Nested particles",
      effects: [],
      generator: createSceneGeneratorInstance(bundledParticleDefinition),
    };
    generatorLayer.generator.parameters.count = 17;
    generated.compositions[1].layers.push(generatorLayer);
    capture(generated, generated.compositions[0].id, [0.125, 1.5], requests);
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, {
      version: 1,
      sources,
      cases,
      generatorDefinition,
      generatorSource,
    });
    return {
      cases: cases.length,
      samples: cases.reduce((n, c) => n + c.samples.length, 0),
      frame_producers: cases.flatMap((c) => c.samples).filter((s) => s.frame).length,
      scope: "recursive-native-source-target-and-budget-planning",
      temporal_text: true,
      whole_project_plan_parity: false,
    };
  } finally {
    await server.close();
  }
}
