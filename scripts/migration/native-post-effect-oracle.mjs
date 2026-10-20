import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function capturePostEffectOracle(root, output, projectInputs) {
  const sources = await Promise.all(
    [
      "scripts/migration/native-post-effect-oracle.mjs",
      "src/renderer/media/material-texture-plan.ts",
      "src/renderer/frame-plan/material-binding-plan.ts",
      "src/renderer/effects/depth-effects.ts",
      "src/renderer/effects/surface-post-effects.ts",
      "src/renderer/frame-plan/post-effect-plan.ts",
      "src/core/scene/camera-optics.ts",
      "src/core/scene/camera-rig.ts",
      "src/renderer/scene/scene-camera.ts",
    ].map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const savedUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const {
      DepthEffectsRenderer,
      DEFAULT_DEPTH_EFFECT_SETTINGS,
      depthEffectSettingsFromCameraOptics,
    } = await server.ssrLoadModule("/src/renderer/effects/depth-effects.ts");
    const { SurfacePostEffectsRenderer } = await server.ssrLoadModule(
      "/src/renderer/effects/surface-post-effects.ts",
    );
    const { evaluateSceneCamera } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-camera.ts",
    );
    const { evaluateCameraBasis } = await server.ssrLoadModule("/src/core/scene/camera-rig.ts");
    const { buildFrameHeader } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-post-plan.ts",
    );
    // Only allocation handles are mocked; the production classes select inputs and pack plans.
    const device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: () => ({}),
    };
    const texture = { createView: () => ({}) };
    const header = (id, time, rate = { numerator: 30, denominator: 1 }, width = 320) =>
      buildFrameHeader({
        snapshot: { snapshotScope: "native-post-effect", projectRevision: 17 },
        compositionId: id,
        time,
        frameRate: rate,
        target: { width: 320, height: 180 },
        renderTarget: { width, height: 180 },
        antiAliasing: "off",
      });
    const bytes = (p) => ({ metadata: p.metadata, blobs: p.blobs.map((b) => Array.from(b)) });
    const attachments = (bits) =>
      Object.fromEntries(
        [
          "scene",
          "worldPosition",
          "transparentWorldPosition",
          "peeledWorldPosition",
          "frontLayerColor",
          "peeledLayerColor",
          "motionBlurSource",
        ].map((k, i) => [k, Boolean(bits & (1 << i))]),
      );
    const depth = [],
      surface = [];
    function captureDepth(input, settings, h, mode, a) {
      const renderer = new DepthEffectsRenderer(device, "rgba16float");
      renderer.setSettings(settings);
      renderer.setSources(
        h.render_target.width,
        h.render_target.height,
        ...[
          "scene",
          "worldPosition",
          "transparentWorldPosition",
          "peeledWorldPosition",
          "frontLayerColor",
          "peeledLayerColor",
        ].map((k) => (a[k] ? texture : undefined)),
        a.motionBlurSource ? "motion_blur" : "scene",
      );
      depth.push({
        input,
        header: h,
        mode,
        attachments: a,
        settings,
        expected: bytes(renderer.buildPlan(h, mode)),
      });
      renderer.destroy();
    }
    const defaults = DEFAULT_DEPTH_EFFECT_SETTINGS;
    for (const value of [null, -100000000, 100000000]) {
      const settings =
        value === null
          ? defaults
          : Object.fromEntries(
              Object.entries(defaults).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.map(() => value) : value,
              ]),
            );
      for (let bits = 0; bits < 128; bits++)
        for (const mode of ["depthFog", "depthOfField"])
          captureDepth(
            { kind: "settings", settings },
            settings,
            header("controls", 0.125),
            mode,
            attachments(bits),
          );
    }
    for (const input of projectInputs) {
      const raw = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(raw), input.sha256);
      const project = JSON.parse(raw);
      for (const c of project.compositions) {
        if (!c.layers.some((l) => l.kind === "camera")) continue;
        for (const [i, time] of [0, 0.125, c.duration / 2].entries()) {
          const camera = evaluateSceneCamera(c, time);
          if (!camera) continue;
          const renderWidth = [160, 320, 640][i],
            tier = i;
          const settings = {
            ...defaults,
            cameraPosition: camera.pose.position,
            cameraForward: evaluateCameraBasis(camera.pose).forward,
            ...depthEffectSettingsFromCameraOptics(camera.optics, c.width, renderWidth),
            transparencyTier: tier,
          };
          captureDepth(
            { kind: "camera", source: input, compositionId: c.id, time, tier, renderWidth },
            settings,
            header(c.id, time, c.frameRate, renderWidth),
            "depthOfField",
            attachments(127),
          );
        }
      }
    }
    for (const renderId of [-1, 0, 1, 0.5, 4294967295, 4294967296, 9007199254740991])
      for (const motionShutterScale of [-1, 0, 0.5, 1, 5])
        for (const resourcesAvailable of [false, true])
          for (const mode of ["selectionIsolation", "vectorMotionBlur"]) {
            const h = header("surface-controls", 0.125),
              settings = { renderId, motionShutterScale, resourcesAvailable },
              renderer = new SurfacePostEffectsRenderer(device, "rgba16float");
            renderer.setSources(
              320,
              180,
              texture,
              texture,
              resourcesAvailable ? texture : undefined,
            );
            renderer.setSelection(renderId);
            renderer.setMotionShutterScale(motionShutterScale);
            surface.push({
              header: h,
              settings,
              mode,
              expected: bytes(renderer.buildPlan(h, mode)),
            });
            renderer.destroy();
          }
    const { planMaterialTextures } = await server.ssrLoadModule(
      "/src/renderer/media/material-texture-plan.ts",
    );
    const { buildMaterialBindingSlice } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/material-binding-plan.ts",
    );
    const materials = [];
    let example;
    const captureMaterial = (layer, environment) => {
      // Both evaluators consume the same persisted numeric values.
      layer = JSON.parse(JSON.stringify(layer));
      if (environment) environment = JSON.parse(JSON.stringify(environment));
      for (const normalReady of [false, true])
        for (const environmentReady of [false, true]) {
          const settings = planMaterialTextures(layer, environment, normalReady, environmentReady);
          const normal = settings.normalEnabled ? "a".repeat(64) : null,
            env = environmentReady ? "b".repeat(64) : null;
          const h = header("native-material", 0.125);
          const plan = buildMaterialBindingSlice(h, {
            ...settings,
            instanceId: layer.id,
            normalHash: normal,
            environmentHash: env,
          });
          materials.push({
            layer,
            environment: environment ?? null,
            normalReady,
            environmentReady,
            normal,
            environmentHash: env,
            header: h,
            settings,
            expected: bytes(plan),
          });
        }
    };
    for (const input of projectInputs) {
      const raw = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(raw), input.sha256);
      for (const c of JSON.parse(raw).compositions)
        for (const layer of c.layers)
          if (layer.kind === "mesh") {
            example ??= layer;
            captureMaterial(layer, c.environment);
          }
    }
    assert(example);
    for (const scale of [-10, -8, -0, 0.125, 8, 10])
      for (const rotation of [-721, -360, -1, 0, 360, 721]) {
        const layer = structuredClone(example);
        layer.mesh.materialTextures = {
          normal: { mimeType: "image/png", dataUrl: "test", texCoord: 0, scale },
        };
        const environment = {
          enabled: true,
          intensity: scale * 8,
          rotation,
          source: { name: "test", mimeType: "image/png", dataUrl: "test" },
        };
        captureMaterial(layer, environment);
      }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, { version: 1, sources, depth, surface, materials });
    return {
      cases: depth.length + surface.length + materials.length,
      materials: materials.length,
      depth: depth.length,
      surface: surface.length,
      scope: "native-depth-and-surface-post-producers",
      whole_project_plan_parity: false,
    };
  } finally {
    await server.close();
    if (savedUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = savedUsage;
  }
}
