import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { frameOutputOracle } from "./native-frame-output-oracle.mjs";
import { projectSurfaceBundle } from "./native-project-surface-oracle.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureProjectFrameOracle(root, output) {
  const paths = [
    "scripts/migration/native-project-frame-oracle.mjs",
    "src/renderer/compositing/precomposition-scene-media.ts",
    "src/renderer/frame-plan/scene-media-plan.ts",
    "src/renderer/frame-plan/resources.ts",
    "src/renderer/frame-plan/frame-bundle-media.ts",
    "src/renderer/media/media-pixel-payload.ts",
    "src/renderer/scene/bundled-particle-generator.ts",
    "src/renderer/scene/scene-generator-plan.ts",
    "src/renderer/scene/scene-generator-program.ts",
    "src/renderer/scene/scene-generator-abi.ts",
    "src/renderer/scene/scene-generator-capacity.ts",
    "src/core/scene/scene-generator-registry.ts",
    "shaders/manifest.json",
    "shaders/scene/particle-compute-layout.wgsl",
    "shaders/scene/particle-compute-functions.wgsl",
    "shaders/scene/particle-render-layout.wgsl",
    "shaders/scene/particle-render-functions.wgsl",
    "shaders/scene/particle-projection.wgsl",
    "scripts/migration/native-project-surface-oracle.mjs",
    "src/renderer/compositing/precomposition-source-evaluation.ts",
    "src/renderer/compositing/precomposition-surface-renderer.ts",
    "src/renderer/compositing/precomposition-scene-plan.ts",
    "src/renderer/frame-plan/precomposition-graph-plan.ts",
    "src/renderer/frame-plan/precomposition-bundle-plan.ts",
    "scripts/migration/native-frame-output-oracle.mjs",
    "examples/projects/minimal-golden.aster.json",
    "src/core/project/project-schema.ts",
    "src/core/animation/text-animator-migration.ts",
    "src/core/media/footage-source.ts",
    "src/core/scene/particle-settings.ts",
    "src/core/scene/scene-evaluation.ts",
    "src/renderer/geometry/geometry.ts",
    "src/renderer/scene/scene-camera.ts",
    "src/renderer/scene/scene-lighting.ts",
    "src/core/animation/motion-blur.ts",
    "src/renderer/scene/time-addressed-motion-vectors.ts",
    "src/renderer/frame-plan/scene-buffer-plan.ts",
    "src/renderer/frame-plan/root-post-plan.ts",
    "src/renderer/frame-plan/root-scene-plan.ts",
    "src/renderer/compositing/render-stack.ts",
    "src/renderer/compositing/root-scene-commands.ts",
    "src/renderer/effects/layer-effect-plan.ts",
    "src/renderer/media/lut-selection-plan.ts",
    "src/renderer/compositing/plan-frame-output.ts",
    "src/renderer/frame-plan/frame-bundle-plan.ts",
    "src/renderer/frame-plan/precomposition-bundle-resources.ts",
    "src/renderer/frame-plan/bundle-effect-records.ts",
    "src/renderer/gpu/auxiliary-buffer-renderer.ts",
    "src/renderer/gpu/auxiliary-buffer-budget.ts",
    "src/renderer/effects/depth-effects.ts",
    "src/renderer/effects/surface-post-effects.ts",
  ];
  const sources = await Promise.all(
    paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const saved = Object.fromEntries(
    ["GPUBufferUsage", "GPUTextureUsage", "GPUShaderStage"].map((k) => [k, globalThis[k]]),
  );
  globalThis.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1 };
  globalThis.GPUShaderStage = { FRAGMENT: 2 };
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const m = {};
    for (const path of paths.filter((p) => p.endsWith(".ts")))
      Object.assign(m, await server.ssrLoadModule(`/${path}`));
    const device = {
      limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 128 },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createPipelineLayout: () => ({}),
      createBindGroupLayout: () => ({}),
      createSampler: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: () => ({ destroy() {} }),
      createTexture: () => ({ destroy() {}, createView: () => ({}) }),
    };
    const captureOutput = await frameOutputOracle(server, device);
    const template = m.cloneCurrentProjectDocument(
      JSON.parse(await readFile(join(root, "examples/projects/minimal-golden.aster.json"))),
    );
    const { shaderSources, ...generator_definition } = m.bundledParticleDefinition;
    const generator_source = {
      pluginName: m.bundledParticleDefinition.pluginName,
      runtimeKey: m.bundledParticleDefinition.runtimeKey,
      shaderSources,
    };
    const cases = [];
    for (const variant of [
      "plain",
      "motion",
      "effect",
      "surface",
      "generator",
      "surface-generator",
      "light",
      "media",
      "surface-media",
    ])
      for (const enabled of [false, true])
        for (const time of [0, 0.125, 0.5]) {
          const project = structuredClone(template),
            c = project.compositions[0];
          c.layers = [c.layers[0]];
          c.layers[0].id = "native-frame-中文-😀";
          c.layers[0].motionBlur = true;
          if (variant !== "plain")
            c.layers[0].transform.position[0] = structuredClone(
              template.compositions[0].layers[1].transform.position[0],
            );
          if (variant === "effect" || variant === "surface")
            c.layers[0].effects = [
              {
                id: "blur",
                type: "gaussian-blur",
                name: "Blur",
                enabled: true,
                parameters: { radius: 12 },
              },
            ];
          if (variant.includes("media")) c.layers[0].kind = "image";
          if (variant.startsWith("surface")) {
            const child = structuredClone(c);
            child.id = "nested-child";
            child.name = "Nested child";
            project.compositions.push(child);
            c.layers[0].effects = [];
            c.layers[0].kind = "precomposition";
            c.layers[0].sourceCompositionId = child.id;
            c.layers[0].threeDimensional = true;
          }
          if (variant.includes("generator")) {
            const layer = {
              ...structuredClone(template.compositions[0].layers[0]),
              id: "root-generator",
              name: "Root particles",
              kind: "generator",
              effects: [],
              generator: m.createSceneGeneratorInstance(m.bundledParticleDefinition),
            };
            layer.generator.parameters.count = 33;
            c.layers.push(layer);
            if (variant === "surface-generator") {
              const nested = structuredClone(layer);
              nested.id = "nested-generator";
              nested.name = "Nested particles";
              nested.generator.parameters.count = 17;
              project.compositions[1].layers.push(nested);
            }
          }
          if (variant === "light") {
            const light = {
              ...structuredClone(template.compositions[0].layers[0]),
              id: "light-source",
              name: "Light",
              kind: "light",
              effects: [],
              threeDimensional: true,
              light: {
                kind: time === 0.125 ? "point" : "directional",
                intensity: 1.25,
                range: 600,
                coneAngle: 45,
                shadowQuality: time === 0.5 ? "off" : "medium",
              },
            };
            c.layers.push(light);
          }
          const shadowMapSize = variant === "light" ? 1024 : 1;
          const primaryLight = c.layers.find((l) => l.kind === "light")?.light;
          const shadowsEnabled =
            shadowMapSize > 1 &&
            primaryLight?.shadowQuality !== "off" &&
            primaryLight?.kind !== "point";
          c.motionBlur = {
            enabled,
            shutterAngle: 180,
            shutterPhase: -90,
            samplesPerFrame: 8,
            adaptiveSampleLimit: 32,
          };
          const request = {
            snapshotScope: "native-project-frame",
            projectRevision: 17,
            compositionId: c.id,
            time,
            target: { width: 320, height: 180 },
            renderTarget: { width: 320, height: 180 },
            antiAliasing: "off",
            shadowsEnabled: false,
          };
          const frameInput = { ...request, snapshot: request, frameRate: c.frameRate };
          const header = m.buildFrameHeader(frameInput);
          const layers = m.flattenSceneLayers(c, project, time);
          const geometryAt = (t) =>
            m.buildSceneGeometry(
              c,
              m.flattenSceneLayers(c, project, t),
              m.evaluateSceneCamera(c, t),
            );
          const generatorAvailable = time !== 0;
          const candidates = layers
            .filter((s) => s.layer.kind === "generator")
            .map((scene) =>
              new m.SceneGeneratorPlanner().prepare({
                scene,
                composition: c,
                definition: m.bundledParticleDefinition,
                width: 320,
                height: 180,
                memoryBudgetMb: 256,
                storageByteLimit: 134217728,
                dispatchWorkgroupLimit: 65535,
                camera: m.evaluateSceneCamera(c, time),
              }),
            );
          const generators = generatorAvailable ? candidates : [];
          const media = {},
            packets = [],
            pixels = [];
          if (variant.includes("media")) {
            const put = (content) => ({
              ...content,
              type: "put_resource",
              hash: m.contentResourceHashSync(content),
            });
            const source = put({
              kind: "media_source",
              descriptor: {
                source_id: "project-frame-image",
                content_identity: "fixed-rgba-v1",
                authorization_scope: "native-project-frame-oracle",
                media_kind: "image",
              },
            });
            const frame = put({
              kind: "media_frame",
              descriptor: {
                source: source.hash,
                sample: { kind: "image" },
                width: 2,
                height: 2,
                format: "rgba8unorm-srgb",
              },
            });
            media.$frame = time === 0 ? null : frame.hash;
            if (time !== 0) {
              packets.push(
                ...[source, frame].map((message) => ({ message, bytes: new Uint8Array() })),
              );
              if (time === 0.5)
                pixels.push(
                  m.createMediaPixelPayload(
                    frame,
                    Uint8Array.from({ length: 16 }, (_, i) => i * 17),
                  ),
                );
            }
            for (const layer of layers)
              if (layer.layer.kind === "image") media[layer.instanceId] = media.$frame;
          }
          const surfaceRevision = enabled ? 1 : request.projectRevision;
          const surfaces = projectSurfaceBundle(
            m,
            project,
            layers,
            surfaceRevision,
            generatorAvailable,
            media,
            packets,
          );
          delete media.$frame;
          const geometry = geometryAt(time),
            settings = m.compositionMotionBlurSettings(c);
          const shutter = m.motionBlurInterval(
            time,
            c.frameRate.numerator / c.frameRate.denominator,
            settings,
          );
          const motion = m.buildTimeAddressedMotionVectors(
            geometry,
            geometryAt(shutter.openTime),
            geometryAt(shutter.closeTime),
            new Set([c.layers[0].id]),
          );
          const effects = m.prepareLayerEffects({
            scene: layers,
            composition: c,
            header,
            mipLevelCount: 4,
            planner: new m.LutSelectionPlanner(),
            context: "root",
          });
          const stack = m.planRootSceneStack(
            layers,
            geometry.batches.map((b) =>
              b.layer.kind === "image" ? { ...b, mediaResourceHash: media[b.instanceId] } : b,
            ),
          );
          const commands = m.planRootSceneCommands(
            stack,
            new Map([...effects].map(([id, e]) => [id, m.effectExecution(e)])),
            new Set(generators.map((g) => g.instanceId)),
            c.background,
          );
          const rootPlan = m.buildRootScenePlan(header, commands, stack.draws);
          const post = m.buildRootPostUniformPlan(frameInput);
          for (const state of ["unavailable", "cleared", "drawn"]) {
            const renderer = new m.AuxiliaryBufferRenderer(device, {}),
              byteBudget = state === "cleared" ? 128 : 67108864;
            if (state !== "unavailable") renderer.enable(1, 1, byteBudget, true);
            const budget = {
              enabled: renderer.enabled,
              depthAvailable: renderer.enabled,
              tier: renderer.depthOfFieldTier,
              estimatedBytes: renderer.estimatedBytes,
              idBufferBytes: 0,
              motionBufferBytes: 0,
              byteBudget,
            };
            const outputs = captureOutput({
              index: variant.includes("media") ? 6 : 0,
              projectDriven: true,
              composition: c,
              header,
              geometry,
              motion,
              budget,
              renderer,
              media,
              surfaces: surfaces.bindings,
              generators: generators
                .filter((g) => g.program.graph.render_variants[g.variantIndex].auxiliary)
                .map((g) => g.instanceId),
              generatorPlans: generators,
              time,
              collectPlan(output, _context, vectors) {
                let scene = m.buildSceneBufferPlan({
                  ...frameInput,
                  geometry,
                  lighting: m.buildSceneLighting(layers, c, shadowsEnabled),
                  shadowsEnabled,
                  motionVectors: vectors,
                });
                scene = m.bindSceneMediaPlan(
                  scene,
                  geometry.batches.flatMap((b, draw_index) =>
                    b.layer.kind === "image"
                      ? [
                          {
                            draw_index,
                            binding:
                              media[b.instanceId] === null
                                ? { kind: "pending" }
                                : { kind: "frame", hash: media[b.instanceId] },
                          },
                        ]
                      : [],
                  ),
                );
                let bundle = m.buildFrameBundle({
                  scene,
                  root: rootPlan,
                  post,
                  output,
                  shadowMapSize,
                  effects,
                  generators: generators.map((plan) => ({ plan, capacity: plan.capacity })),
                  resources: packets,
                  precompositions: surfaces.bundle,
                });
                if (pixels.length) bundle = m.withFrameBundleMedia(bundle, pixels);
                return {
                  plan: {
                    metadata: bundle.plan.metadata,
                    blobs: bundle.plan.blobs.map((b) => Array.from(b)),
                  },
                  resources: bundle.resources.map((r) => ({
                    message: r.message,
                    byte_length: r.bytes.length,
                    payload_sha256: sha256(r.bytes),
                  })),
                };
              },
            });
            cases.push({
              project,
              request,
              outputs,
              media,
              packets: packets.map((p) => ({ message: p.message, bytes: Array.from(p.bytes) })),
              pixels: pixels.map((p) => ({
                frame: p.frame.hash,
                pixels: { message: p.pixels.message, bytes: Array.from(p.pixels.bytes) },
              })),
              shadow_map_size: shadowMapSize,
              surface_revision: surfaceRevision,
              generator_available: generatorAvailable,
              realization_order: [
                ...candidates.map((g) => g.instanceId),
                ...surfaces.realization_order,
              ],
            });
            renderer.disable();
          }
        }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, {
      version: 1,
      sources,
      cases,
      generator_definition,
      generator_source,
    });
    return {
      cases: cases.length,
      frames: cases.reduce((n, c) => n + c.outputs.length, 0),
      scope: "native-project-frame-orchestration-motion-effects-surfaces-generators-lighting-media",
      whole_project_plan_parity: false,
    };
  } finally {
    await server.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}
