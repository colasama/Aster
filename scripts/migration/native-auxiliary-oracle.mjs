import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { frameOutputOracle } from "./native-frame-output-oracle.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureAuxiliaryOracle(root, output, projectInputs) {
  const sources = await Promise.all(
    [
      "scripts/migration/native-auxiliary-oracle.mjs",
      "scripts/migration/native-frame-output-oracle.mjs",
      "src/renderer/compositing/plan-frame-output.ts",
      "src/renderer/effects/depth-effects.ts",
      "src/renderer/effects/surface-post-effects.ts",
      "src/renderer/frame-plan/frame-output-plans.ts",
      "src/renderer/frame-plan/final-output-plan.ts",
      "src/renderer/frame-plan/motion-reconstruction-plan.ts",
      "src/core/animation/motion-blur.ts",
      "src/renderer/gpu/auxiliary-buffer-renderer.ts",
      "src/renderer/gpu/auxiliary-buffer-data.ts",
      "src/renderer/gpu/auxiliary-buffer-budget.ts",
      "src/renderer/gpu/auxiliary-plan-bindings.ts",
      "src/renderer/gpu/render-buffers.ts",
      "src/renderer/frame-plan/auxiliary-plan.ts",
      "src/renderer/scene/time-addressed-motion-vectors.ts",
      "src/renderer/geometry/geometry.ts",
      "src/core/scene/scene-evaluation.ts",
    ].map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })),
  );
  const saved = {
    GPUBufferUsage: globalThis.GPUBufferUsage,
    GPUTextureUsage: globalThis.GPUTextureUsage,
    GPUShaderStage: globalThis.GPUShaderStage,
  };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1 };
  globalThis.GPUShaderStage = { FRAGMENT: 2 };
  globalThis.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { AuxiliaryBufferRenderer } = await server.ssrLoadModule(
      "/src/renderer/gpu/auxiliary-buffer-renderer.ts",
    );
    const { flattenSceneLayers } = await server.ssrLoadModule(
      "/src/core/scene/scene-evaluation.ts",
    );
    const { buildSceneGeometry } = await server.ssrLoadModule("/src/renderer/geometry/geometry.ts");
    const { evaluateSceneCamera } = await server.ssrLoadModule(
      "/src/renderer/scene/scene-camera.ts",
    );
    const { buildFrameHeader } = await server.ssrLoadModule(
      "/src/renderer/frame-plan/root-post-plan.ts",
    );
    const { idBufferCapacityBytes } = await server.ssrLoadModule(
      "/src/renderer/gpu/auxiliary-buffer-data.ts",
    );
    const { motionVectorBufferBytes } = await server.ssrLoadModule(
      "/src/renderer/scene/time-addressed-motion-vectors.ts",
    );
    // Allocation handles only: production enable/buildPlan select budgets, IDs and textures.
    const device = {
      limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 128 },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: () => ({}),
      createPipelineLayout: () => ({}),
      createBindGroupLayout: () => ({}),
      createTexture: () => ({ destroy() {}, createView: () => ({}) }),
    };
    const captureOutput = await frameOutputOracle(server, device);
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const documents = [],
      cases = [],
      budgets = [];
    for (const input of projectInputs) {
      const bytes = await readFile(isAbsolute(input.path) ? input.path : join(root, input.path));
      assert.equal(sha256(bytes), input.sha256);
      const project = JSON.parse(bytes);
      documents.push({
        input,
        project,
        compositions: [
          ...new Set(input.cases.map((id) => corpus.cases.find((c) => c.id === id)?.composition)),
        ],
      });
    }
    const base = JSON.parse(
      await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
    );
    const numbers = [];
    let seed = 0x92d68ca2n;
    const bits = Buffer.alloc(8);
    for (let i = 0; i < 512; i++) {
      seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
      bits.writeBigUInt64LE(seed);
      const value = bits.readDoubleLE();
      if (Number.isFinite(value)) numbers.push(value);
    }
    const material = {
      metallic: 0.2,
      roughness: 0.5,
      emissive: 0,
      alphaMode: "opaque",
      alphaCutoff: 0.5,
    };
    for (let variant = 0; variant < 12; variant++) {
      const project = structuredClone(base),
        composition = project.compositions[0];
      composition.layers = [structuredClone(composition.layers[0])];
      const layer = composition.layers[0];
      layer.id = `object-中文-é-e\u0301-😀-${variant}`;
      const entries = Object.entries(material);
      if (variant & 1) entries.reverse();
      layer.material = Object.fromEntries(entries);
      layer.material.extra = {
        numbers,
        z: [1e-7, 1e-6, 1e20, 1e21, -0, Number("9007199254740993"), 0.000123456789],
        a: '\b\f\n\r\t\\"😀',
        4294967295: true,
        10: null,
        2: false,
        "01": [null, true],
      };
      if (variant & 2)
        layer.material.extra = Object.fromEntries(Object.entries(layer.material.extra).reverse());
      if (variant & 4) {
        layer.mesh = {
          name: "material-source",
          positions: [],
          normals: [],
          uvs: [],
          indices: [],
          sourceMaterial: layer.material,
        };
        layer.material = null;
      }
      if (variant >= 8) {
        delete layer.material;
        delete layer.mesh;
      }
      const document = JSON.stringify(project)
        .replaceAll('"emissive":0', '"emissive":-0')
        .replaceAll('"metallic":0.2', '"metallic":2e-1')
        .replaceAll("9007199254740992", "9007199254740993");
      documents.push({
        input: { document, sha256: sha256(Buffer.from(document)) },
        project,
        compositions: [composition.id],
      });
    }
    for (const [index, entry] of documents.entries()) {
      for (const id of entry.compositions) {
        const composition = entry.project.compositions.find((c) => c.id === id);
        assert(composition);
        const request = {
          snapshotScope: "native-auxiliary",
          projectRevision: 17,
          compositionId: id,
          time: 0.125,
          target: { width: 320, height: 180 },
          renderTarget: { width: 320, height: 180 },
          antiAliasing: "off",
          shadowsEnabled: false,
        };
        const layers = flattenSceneLayers(composition, entry.project, request.time);
        const geometry = buildSceneGeometry(
          composition,
          layers,
          evaluateSceneCamera(composition, request.time),
        );
        const header = buildFrameHeader({
          ...request,
          snapshot: request,
          frameRate: composition.frameRate,
        });
        const vertexCount = geometry.data.length / 40;
        const generators = layers
          .filter((s) => s.layer.kind === "generator")
          .map((s) => s.instanceId)
          .reverse();
        const media = {},
          surfaces = {};
        for (const [i, batch] of geometry.batches.entries()) {
          media[batch.instanceId] = i % 3 ? sha256(Buffer.from(batch.instanceId)) : null;
          if (i % 3 === 1) surfaces[batch.instanceId] = "surface-target";
        }
        const variants = [];
        for (let mode = 0; mode < 5; mode++) {
          const renderer = new AuxiliaryBufferRenderer(device, {});
          const byteBudget = mode === 1 ? 128 : 64 * 1024 * 1024;
          if (mode !== 0) renderer.enable(1, 1, byteBudget, mode >= 3);
          const budget = {
            enabled: renderer.enabled,
            depthAvailable: renderer.enabled,
            tier: renderer.depthOfFieldTier,
            estimatedBytes: renderer.estimatedBytes,
            idBufferBytes: 0,
            motionBufferBytes: 0,
            byteBudget,
          };
          const motion =
            mode >= 3
              ? Float32Array.from({ length: vertexCount * 2 }, (_, i) => ((i % 65) - 32) / 4)
              : undefined;
          const built = renderer.buildPlan({
            header,
            vertexCount,
            batches: geometry.batches,
            motionVectors: motion,
            mediaBinding: (batch) =>
              surfaces[batch.instanceId]
                ? { texture: { kind: "surface", instance_id: batch.instanceId }, binding: {} }
                : media[batch.instanceId]
                  ? { texture: { kind: "media", hash: media[batch.instanceId] }, binding: {} }
                  : undefined,
            generators: generators.map((instanceId) => ({ instanceId, draw: {} })),
          });
          variants.push({
            budget,
            outputs: captureOutput({
              index,
              composition,
              header,
              geometry,
              motion,
              budget,
              renderer,
              media,
              surfaces,
              generators,
              time: request.time,
            }),
            motion: motion ? Array.from(motion) : null,
            expected: {
              metadata: built.plan.metadata,
              blobs: built.plan.blobs.map((b) => Array.from(b)),
            },
          });
          renderer.disable();
        }
        cases.push({ project: index, request, media, surfaces, generators, variants });
      }
    }
    for (const draws of [0, 1, 2, 3, 7, 8, 9, 65536])
      for (const vertices of [0, 1, 6, 9, 1025])
        for (const retained of [0, 8192]) {
          const planned =
            4096 +
            Math.max(retained, idBufferCapacityBytes(draws)) +
            Math.max(retained, motionVectorBufferBytes(vertices));
          for (const delta of [-1, 0, 1])
            budgets.push({
              draws,
              vertices,
              budget: {
                enabled: true,
                depthAvailable: true,
                tier: 2,
                estimatedBytes: 4096,
                idBufferBytes: retained,
                motionBufferBytes: retained,
                byteBudget: planned + delta,
              },
              expected: delta < 0 ? "cleared" : "drawn",
            });
        }
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, {
      version: 1,
      sources,
      projects: documents.map((d) => d.input),
      cases,
      budgets,
    });
    return {
      cases: cases.length,
      plans: cases.reduce((n, c) => n + c.variants.length, 0),
      budgets: budgets.length,
      output_plans: cases.reduce(
        (n, c) => n + c.variants.reduce((v, s) => v + s.outputs.length, 0),
        0,
      ),
      scope: "native-auxiliary-producer",
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
