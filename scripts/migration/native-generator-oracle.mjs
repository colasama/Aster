import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureGeneratorOracle(root, output, projectInputs) {
  const paths = [
    "src/renderer/scene/scene-generator-plan.ts",
    "src/renderer/scene/scene-generator-abi.ts",
    "src/renderer/scene/scene-generator-capacity.ts",
    "src/renderer/scene/scene-generator-program.ts",
    "src/renderer/scene/bundled-particle-generator.ts",
    "src/core/scene/scene-generator-registry.ts",
    "src/core/scene/camera-rig.ts",
    "src/core/scene/camera-settings.ts",
    "src/core/animation/layer-time.ts",
    "src/renderer/gpu/render-buffers.ts",
    "scripts/migration/native-generator-oracle.mjs",
    "src/renderer/frame-plan/generator-plan.ts",
    "src/renderer/frame-plan/root-post-plan.ts",
    "shaders/manifest.json",
    "shaders/scene/particle-compute-layout.wgsl",
    "shaders/scene/particle-compute-functions.wgsl",
    "shaders/scene/particle-render-layout.wgsl",
    "shaders/scene/particle-render-functions.wgsl",
    "shaders/scene/particle-projection.wgsl",
  ];
  const sources = await Promise.all(
    paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { bundledParticleDefinition } = await server.ssrLoadModule(
      "/src/renderer/scene/bundled-particle-generator.ts",
    );
    const { createSceneGeneratorInstance } = await server.ssrLoadModule(
      "/src/core/scene/scene-generator-registry.ts",
    );
    const { SceneGeneratorPlanner } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-generator-plan.ts",
    );
    const { createBlankProject } = await server.ssrLoadModule("/src/core/project/project.ts");
    const { createGeneratorLayerForComposition } = await server.ssrLoadModule(
      "/src/core/layers/layer-factory.ts",
    );
    const { flattenSceneLayers } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { evaluateLayerSourceTime } = await server.ssrLoadModule(
      "/src/core/animation/layer-time.ts",
    );
    const { createDefaultEvaluatedCamera } = await server.ssrLoadModule(
      "/src/core/scene/camera-settings.ts",
    );
    const { buildGeneratorSlice } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/generator-plan.ts",
    );
    const { buildFrameHeader } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-post-plan.ts",
    );
    const { compositionIdentityFromString } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/composition-identity.ts",
    );
    const programSource = {
      pluginName: bundledParticleDefinition.pluginName,
      runtimeKey: bundledParticleDefinition.runtimeKey,
      shaderSources: bundledParticleDefinition.shaderSources,
    };
    const cases = [];
    const definition = { ...bundledParticleDefinition, shaderSources: undefined };
    function capture(project, layer, time, device, camera, override = {}) {
      // The candidate consumes persisted JSON; evaluate the same serialized parameter values.
      layer.generator = JSON.parse(JSON.stringify(layer.generator));
      const composition = project.compositions.find((c) => c.layers.includes(layer));
      const scene = flattenSceneLayers(composition, project, time).find((s) => s.layer === layer);
      if (!scene) return;
      const runtimeDefinition = { ...bundledParticleDefinition, ...override };
      const planner = new SceneGeneratorPlanner();
      if (runtimeDefinition.audioAnalysis)
        planner.beginFrame(() => {
          const values = Float32Array.from({ length: 2320 }, (_, i) => i / 2320);
          new Uint32Array(values.buffer).set([128, 16, 256, 1]);
          return values;
        });
      const plan = planner.prepare({
        scene,
        composition,
        definition: runtimeDefinition,
        width: 177,
        height: 93,
        ...device,
        camera,
      });
      const words = (bytes) =>
        Array.from(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
      const header = buildFrameHeader({
        snapshot: { snapshotScope: "native-generator", projectRevision: 17 },
        compositionId: composition.id,
        time,
        frameRate: composition.frameRate,
        target: { width: 177, height: 93 },
        renderTarget: { width: 177, height: 93 },
        antiAliasing: "off",
      });
      const slice = buildGeneratorSlice(header, plan);
      cases.push({
        project: structuredClone(project),
        header,
        invocation: {
          instance_id: compositionIdentityFromString(plan.instanceId),
          selection_id: compositionIdentityFromString(plan.selectionId),
          blend_mode: plan.blendMode,
        },
        audio: plan.audio ? words(plan.audio) : null,
        plan: { metadata: slice.metadata, blobs: slice.blobs.map((b) => Array.from(b)) },
        programResources: plan.program.shaders.map((r) => ({
          message: r.message,
          byte_length: r.bytes.length,
          payload_sha256: sha256(r.bytes),
        })),
        definition: { ...definition, ...override },
        instance: structuredClone(layer.generator),
        layer: structuredClone(layer),
        time,
        context: {
          compositionSize: [composition.width, composition.height],
          renderSize: [177, 93],
          compositionTime: scene.localTime,
          sourceTime: evaluateLayerSourceTime(layer, scene.localTime),
          frameDuration:
            composition.frameRate.denominator / Math.max(composition.frameRate.numerator, 1),
          transform: scene.transform,
          selectionId: scene.selectionId,
          layerKind: layer.kind,
          threeDimensional: layer.threeDimensional,
          camera: camera ? structuredClone(camera) : null,
        },
        device,
        expected: {
          variantIndex: plan.variantIndex,
          requestedCount: plan.requestedCount,
          effectiveCount: plan.effectiveCount,
          capacity: plan.capacity,
          context: words(plan.context),
          parameters: words(plan.parameters),
          indirect: words(plan.indirect),
          dispatches: plan.dispatches,
        },
      });
    }
    const device = {
      memoryBudgetMb: 32,
      storageByteLimit: 512 * 1024 * 1024,
      dispatchWorkgroupLimit: 65535,
    };
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      const project = JSON.parse(bytes);
      for (const composition of project.compositions)
        for (const layer of composition.layers)
          if (layer.generator?.pluginId === definition.pluginId)
            for (const time of [0.125, 1.75]) capture(project, layer, time, device);
    }
    const corpusCases = cases.length;
    const project = createBlankProject(),
      composition = project.compositions[0];
    const instance = createSceneGeneratorInstance(bundledParticleDefinition),
      layer = createGeneratorLayerForComposition(composition, instance);
    composition.layers = [layer];
    layer.id = "generator-😀-日本語";
    layer.inPoint = -10;
    layer.outPoint = 100;
    layer.timeOffset = 1.25;
    layer.timeStretch = -2;
    for (const mode of ["billboard", "streak", "mesh", "unknown"])
      for (const count of [0, 1.5, 1500, 1000000, 2000000])
        for (const device of [
          { memoryBudgetMb: 8, storageByteLimit: 1048576, dispatchWorkgroupLimit: 2 },
          { memoryBudgetMb: 512, storageByteLimit: 536870912, dispatchWorkgroupLimit: 65535 },
        ]) {
          layer.generator.parameters.count = count;
          layer.generator.parameters.renderMode = mode;
          capture(project, layer, 6, device);
        }
    const camera = createDefaultEvaluatedCamera(composition.width, composition.height);
    camera.pose.mode = "two-node";
    camera.pose.pointOfInterest = [10, 50, 100];
    camera.pose.rotation = [12, 23, 34];
    camera.pose.orientation = [13, -35, 71];
    camera.optics.projection = "orthographic";
    camera.projection.orthographicSize = 1234;
    capture(project, layer, 3, device, camera);
    for (const parameters of [
      {},
      { count: true, renderMode: 7, lifetime: "wrong" },
      { count: 27.5, renderMode: "mesh" },
    ]) {
      layer.generator = { ...instance, parameters };
      capture(project, layer, 2.25, device, camera);
    }
    const extra = [
      {
        name: "test_vector",
        type: "vector",
        label: "Vector",
        default: [0.1, 0.2, 0.3],
        min: -10,
        max: 10,
      },
      { name: "test_color", type: "color", label: "Color", default: [0.1, 0.2, 0.3, 0.4] },
    ];
    for (const values of [
      [-100, 0.25, 100],
      [1, 2],
      [-0, 1, 0.5],
    ]) {
      layer.generator = {
        ...instance,
        parameters: { ...instance.parameters, test_vector: values, test_color: [-1, 0.25, 5, 1] },
      };
      capture(project, layer, 0, device, camera, {
        parameters: [...definition.parameters, ...extra],
      });
    }
    for (const value of [
      0,
      -0,
      1.0,
      1.25,
      -1496410512421605.2,
      -1803264175706971.2,
      1e-6,
      1e-7,
      1e20,
      1e21,
      1e23,
      1000000000000000100,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      [1.0, -0, 1e21],
      [1e-7, 0.000001],
    ]) {
      const choices = ["fallback", String(value), "third"];
      layer.generator = { ...instance, parameters: { ...instance.parameters, renderMode: value } };
      capture(project, layer, 0.5, device, camera, {
        parameters: definition.parameters.map((p) =>
          p.name === "renderMode" ? { ...p, choices, default: choices[0] } : p,
        ),
        graph: {
          ...definition.graph,
          render_variants: definition.graph.render_variants.map((v, i) => ({
            ...v,
            selector_value: choices[i],
          })),
        },
      });
    }
    for (const time of [0, 1.5])
      capture(project, layer, time, device, camera, { audioAnalysis: true });
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, { version: 1, sources, programSource, cases });
    return { cases: cases.length, corpus_cases: corpusCases };
  } finally {
    await server.close();
  }
}
