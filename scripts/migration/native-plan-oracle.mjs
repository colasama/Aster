import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function capturePlanOracle(root, output, projectInputs) {
  const paths = [
    "scripts/migration/native-plan-oracle.mjs",
    "src/renderer/frame-plan/scene-media-plan.ts",
    "src/renderer/media/material-texture-plan.ts",
    "src/renderer/frame-plan/material-binding-plan.ts",
    "src/renderer/frame-plan/bundle-effect-records.ts",
    "src/renderer/frame-plan/precomposition-bundle-resources.ts",
    "src/renderer/frame-plan/scene-buffer-plan.ts",
    "src/renderer/frame-plan/root-post-plan.ts",
    "src/renderer/frame-plan/frame-rate.ts",
    "src/renderer/frame-plan/time.ts",
    "src/renderer/effects/post-process.ts",
    "src/renderer/effects/effect-parameters.ts",
    "src/renderer/geometry/geometry.ts",
    "src/renderer/scene/scene-camera.ts",
    "src/renderer/scene/scene-lighting.ts",
    "src/core/scene/scene-evaluation.ts",
    "src/core/scene/cloner.ts",
    "src/renderer/compositing/render-stack.ts",
    "src/renderer/compositing/root-scene-commands.ts",
    "src/renderer/frame-plan/root-scene-plan.ts",
    "src/renderer/scene/scene-draw-plan.ts",
    "src/renderer/effects/layer-effect-plan.ts",
    "src/core/animation/motion-blur.ts",
    "src/renderer/scene/time-addressed-motion-vectors.ts",
    "src/renderer/frame-plan/motion-reconstruction-plan.ts",
    "src/renderer/compositing/motion-blur-uniforms.ts",
    "src/renderer/frame-plan/final-output-plan.ts",
    "src/renderer/gpu/render-buffers.ts",
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
    const { flattenSceneLayers } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { buildSceneGeometry } = await server.ssrLoadModule("/src/renderer/geometry/geometry.ts");
    const { evaluateSceneCamera } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-camera.ts",
    );
    const { buildSceneLighting } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-lighting.ts",
    );
    const { buildSceneBufferPlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/scene-buffer-plan.ts",
    );
    const { buildRootPostUniformPlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-post-plan.ts",
    );
    const { frameRateFromNumbers } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/frame-rate.ts",
    );
    const { planRootSceneStack } = await server.ssrLoadModule(
      "/src/renderer/compositing/render-stack.ts",
    );
    const { planRootSceneCommands } = await server.ssrLoadModule(
      "/src/renderer/compositing/root-scene-commands.ts",
    );
    const { buildRootScenePlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-scene-plan.ts",
    );
    const { prepareLayerEffects, effectExecution } = await server.ssrLoadModule(
      "/src/renderer/effects/layer-effect-plan.ts",
    );
    const { LutSelectionPlanner } = await server.ssrLoadModule(
      "/src/renderer/media/lut-selection-plan.ts",
    );
    const { buildFrameHeader } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-post-plan.ts",
    );
    const { buildBundleEffects } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/bundle-effect-records.ts",
    );
    const { PrecompositionBundleResources } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/precomposition-bundle-resources.ts",
    );
    const effectRecords = (effects) => {
      const resources = new PrecompositionBundleResources();
      const records = buildBundleEffects(effects, resources);
      return {
        records,
        resources: [...resources.used].sort().map((hash) => {
          const r = resources.resolve(hash);
          return {
            message: r.message,
            byte_length: r.bytes.length,
            payload_sha256: sha256(r.bytes),
          };
        }),
      };
    };
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const { buildFinalOutputPlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/final-output-plan.ts",
    );
    const { BUFFER_VISUALIZATIONS } = await server.ssrLoadModule(
      "/src/renderer/gpu/render-buffers.ts",
    );
    const motion = await server.ssrLoadModule("/src/core/animation/motion-blur.ts");
    const { buildTimeAddressedMotionVectors } = await server.ssrLoadModule(
      "/src/renderer/scene/time-addressed-motion-vectors.ts",
    );
    const { buildMotionReconstructionPlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/motion-reconstruction-plan.ts",
    );
    const { planMaterialTextures } = await server.ssrLoadModule(
      "/src/renderer/media/material-texture-plan.ts",
    );
    const { bindSceneMediaPlan } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/scene-media-plan.ts",
    );
    const projects = [],
      cases = [],
      rates = [],
      shutters = [],
      outputs = [];
    const plan = (p) => ({
      metadata: p.metadata,
      floats: Array.from(
        new Float32Array(p.blobs[0].buffer, p.blobs[0].byteOffset, p.blobs[0].byteLength / 4),
      ),
    });
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      const project = JSON.parse(bytes),
        projectIndex = projects.length;
      projects.push(input);
      const ids = new Set(
        input.cases.map((id) => corpus.cases.find((c) => c.id === id)?.composition),
      );
      for (const id of ids) {
        const composition = project.compositions.find((c) => c.id === id);
        assert(composition);
        for (const time of [0.125, composition.duration / 2]) {
          const request = {
            snapshotScope: "native-scene-producer",
            projectRevision: 17,
            compositionId: id,
            time,
            target: { width: 320, height: 180 },
            renderTarget: { width: 640, height: 360 },
            antiAliasing: "ssaa2x",
            shadowsEnabled: time === 0.125,
          };
          const textBounds = {};
          const bindings = {
            media: {},
            generators: [],
            material_resources: { normals: {}, environment: null },
          };
          let expected = null,
            error = false;
          try {
            const scene = flattenSceneLayers(composition, project, time),
              camera = evaluateSceneCamera(composition, time);
            for (const entry of scene)
              if (entry.layer.kind === "text")
                textBounds[entry.resourceInstanceId] = {
                  x: -12,
                  y: -8,
                  width: entry.layer.size[0] + 25,
                  height: entry.layer.size[1] + 17,
                };
            const header = {
              ...request,
              snapshot: {
                snapshotScope: request.snapshotScope,
                projectRevision: request.projectRevision,
              },
              frameRate: composition.frameRate,
            };
            const geometry = buildSceneGeometry(composition, scene, camera, (id) => textBounds[id]);
            for (const batch of geometry.batches) {
              if (["image", "video", "text"].includes(batch.layer.kind)) {
                const hash = time === 0.125 ? sha256(Buffer.from(batch.instanceId)) : null;
                batch.mediaResourceHash = hash;
                bindings.media[batch.instanceId] = hash;
              }
            }
            bindings.generators = scene
              .filter(
                (entry, index) =>
                  entry.layer.kind === "generator" && (time === 0.125 || index % 2 === 0),
              )
              .map((entry) => entry.instanceId);
            const materialResources = bindings.material_resources;
            if (
              composition.environment?.enabled &&
              geometry.batches.some((b) => b.layer.kind === "mesh") &&
              time === 0.125
            )
              materialResources.environment = sha256(Buffer.from("native-environment"));
            for (const batch of geometry.batches)
              if (batch.layer.kind === "mesh") {
                const normal =
                  batch.layer.mesh?.materialTextures?.normal?.dataUrl && time === 0.125
                    ? sha256(Buffer.from(`normal:${batch.resourceInstanceId}`))
                    : null;
                if (normal) materialResources.normals[batch.resourceInstanceId] = normal;
                batch.materialTexturePlan = {
                  ...planMaterialTextures(
                    batch.layer,
                    composition.environment,
                    normal !== null,
                    materialResources.environment !== null,
                  ),
                  instanceId: batch.resourceInstanceId,
                  normalHash: normal,
                  environmentHash: materialResources.environment,
                };
              }
            const actualHeader = buildFrameHeader(header);
            const effects = prepareLayerEffects({
              scene,
              composition,
              header: actualHeader,
              mipLevelCount: 4,
              planner: new LutSelectionPlanner(),
              context: "root",
            });
            const stack = planRootSceneStack(scene, geometry.batches);
            const commands = planRootSceneCommands(
              stack,
              new Map([...effects].map(([id, effect]) => [id, effectExecution(effect)])),
              new Set(bindings.generators),
              composition.background,
            );
            const root = buildRootScenePlan(actualHeader, commands, stack.draws);
            const settings = motion.compositionMotionBlurSettings(composition);
            const interval = motion.motionBlurInterval(
              time,
              composition.frameRate.numerator / composition.frameRate.denominator,
              settings,
            );
            const endpoint = (time) =>
              buildSceneGeometry(
                composition,
                flattenSceneLayers(composition, project, time),
                evaluateSceneCamera(composition, time),
                (id) => textBounds[id],
              );
            const enabled = new Set(
              geometry.batches
                .filter(
                  (s) =>
                    motion.layerMotionBlurEnabled(s.layer) &&
                    motion.layerSupportsMotionBlur(s.layer),
                )
                .map((s) => s.selectionId),
            );
            const vectors = buildTimeAddressedMotionVectors(
              geometry,
              endpoint(interval.openTime),
              endpoint(interval.closeTime),
              enabled,
            );
            const reconstruction = buildMotionReconstructionPlan(actualHeader, {
              requested: settings.enabled,
              resourcesAvailable: time === 0.125,
              settings,
              shutter: interval,
              compositionWidth: composition.width,
            });
            const motionScene = buildSceneBufferPlan({
              ...header,
              geometry,
              lighting: buildSceneLighting(
                scene,
                composition,
                request.shadowsEnabled,
                camera?.pose.position,
              ),
              shadowsEnabled: request.shadowsEnabled,
              motionVectors: vectors,
            });
            const mediaBindings = geometry.batches.flatMap((batch, draw_index) =>
              batch.mediaResourceHash === undefined
                ? []
                : [
                    {
                      draw_index,
                      binding:
                        batch.mediaResourceHash === null
                          ? { kind: "pending" }
                          : { kind: "frame", hash: batch.mediaResourceHash },
                    },
                  ],
            );
            const sceneMedia = bindSceneMediaPlan(motionScene, mediaBindings);
            expected = {
              mediaBindings,
              sceneMedia: plan(sceneMedia),
              effects: effectRecords(effects),
              surfaceEffects: effectRecords(
                prepareLayerEffects({
                  scene,
                  composition,
                  header: actualHeader,
                  mipLevelCount: 4,
                  planner: new LutSelectionPlanner(),
                  context: "precomposition",
                }),
              ),
              scene: plan(
                buildSceneBufferPlan({
                  ...header,
                  geometry,
                  lighting: buildSceneLighting(
                    scene,
                    composition,
                    request.shadowsEnabled,
                    camera?.pose.position,
                  ),
                  shadowsEnabled: request.shadowsEnabled,
                }),
              ),
              post: plan(buildRootPostUniformPlan(header)),
              root: { metadata: root.metadata, blobs: root.blobs.map((b) => Array.from(b)) },
              motion: {
                scene: plan(motionScene),
                settings,
                interval,
                enabled: [...enabled].sort(),
                vectors: Array.from(vectors),
                plan: {
                  metadata: reconstruction.metadata,
                  blobs: reconstruction.blobs.map((b) => Array.from(b)),
                },
              },
            };
          } catch {
            error = true;
          }
          cases.push({ project: projectIndex, request, textBounds, bindings, expected, error });
        }
      }
    }
    for (const [numerator, denominator] of [
      [24, 1],
      [24000, 1001],
      [48, 2],
      [23.976, 1],
      [1.5, 0.25],
      [2 ** 40, 2 ** 38],
      [Number.MIN_VALUE, Number.MIN_VALUE],
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [(1 + Number.EPSILON) * 2 ** 83, 1],
      [1e-300, 1e300],
      [1.0000000000000002, 3.75],
    ])
      rates.push({
        numerator,
        denominator,
        expected: frameRateFromNumbers({ numerator, denominator }),
      });
    for (const raw of [
      null,
      {
        enabled: true,
        shutterAngle: 0,
        shutterPhase: -90,
        samplesPerFrame: 8,
        adaptiveSampleLimit: 32,
      },
      {
        enabled: true,
        shutterAngle: 900,
        shutterPhase: -900,
        samplesPerFrame: 1.5,
        adaptiveSampleLimit: 1,
      },
      {
        enabled: true,
        shutterAngle: -5,
        shutterPhase: 900,
        samplesPerFrame: 100,
        adaptiveSampleLimit: 300,
      },
      {
        enabled: true,
        shutterAngle: 359.9,
        shutterPhase: 72.5,
        samplesPerFrame: 15.5,
        adaptiveSampleLimit: 40.5,
      },
    ])
      for (const frameRate of [0, 0.5, 23.976, 1001, 1e9])
        for (const travel of [0, 7.9, 8, 65, 1e9]) {
          const settings = motion.compositionMotionBlurSettings({ motionBlur: raw });
          const adaptive = motion.adaptiveMotionBlurSampleCount(settings, travel);
          shutters.push({
            source: raw,
            time: -0.125,
            frameRate,
            travel,
            settings,
            adaptive,
            interval: motion.motionBlurInterval(-0.125, frameRate, settings, adaptive),
          });
        }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    const header = cases.find((c) => c.expected).expected.post.metadata.header;
    for (const visualization of BUFFER_VISUALIZATIONS)
      for (let bits = 0; bits < 16; bits++) {
        const input = {
          visualization,
          auxiliaryValid: !!(bits & 1),
          beautyDepthOfField: !!(bits & 2),
          motionBlurValid: !!(bits & 4),
          motionBlurBindingAvailable: !!(bits & 8),
        };
        const p = buildFinalOutputPlan(header, input);
        outputs.push({
          header,
          input,
          expected: { metadata: p.metadata, blobs: p.blobs.map((b) => Array.from(b)) },
        });
      }
    await writeAtomicJson(output, {
      version: 1,
      sources,
      projects,
      cases,
      rates,
      shutters,
      outputs,
    });
    return {
      cases: cases.length,
      projects: projects.length,
      frame_rates: rates.length,
      shutters: shutters.length,
      output_routes: outputs.length,
      moving_cases: cases.filter((c) => c.expected?.motion.vectors.some((v) => v !== 0)).length,
      scope: "native-scene-post-root-command-and-motion-producers",
      whole_project_plan_parity: false,
    };
  } finally {
    await server.close();
  }
}
