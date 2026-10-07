import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { hashFile } from "./source.mjs";

/** Route frozen generator invocations through supplied auxiliary and post-output plans. */
export async function generatorOutputFixtures(root) {
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const m = {};
    for (const name of [
      "codec",
      "frame-bundle-read",
      "frame-bundle-plan",
      "composition-identity",
      "auxiliary-plan",
      "post-effect-plan",
      "final-output-plan",
      "motion-reconstruction-plan",
    ])
      Object.assign(m, await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    const { motionSettings } = await server.ssrLoadModule(
      "/tests/parity/output-replay/fixtures.ts",
    );
    const ledger = JSON.parse(
      await readFile(join(root, "docs/migration/rust-renderer-progress.json"), "utf8"),
    );
    const pin = ledger.milestones.find((v) => v.id === "M3").input_manifest;
    assert.equal(await hashFile(join(root, pin.path)), pin.sha256);
    const base = pin.path.replace(/\/manifest.json$/, "");
    const read = async (caseId, frame) => {
      const source = `${base}/${caseId}/${frame}/replay.fpln`;
      const messages = JSON.parse(
        await readFile(join(root, base, caseId, `${frame}/resources.json`), "utf8"),
      );
      const resources = await Promise.all(
        messages.map(async (message) => ({
          message,
          bytes: new Uint8Array(
            await readFile(join(root, base, caseId, "frame-resources", `${message.hash}.bin`)),
          ),
        })),
      );
      return {
        source,
        resources,
        frame: m.readFrameBundle({
          plan: m.decodeFramePlan(new Uint8Array(await readFile(join(root, source)))),
          resources,
        }),
      };
    };
    const depth = (await read("scene-dof-55", 15)).frame.plans.output.effect;
    const frames = [];
    for (const kind of ["billboard", "mesh", "streak", "bars", "ring", "scope"]) {
      const audio = ["bars", "ring", "scope"].includes(kind);
      const {
        source,
        resources,
        frame: original,
      } = await read(`scene-${audio ? "audio-spectrum" : "particles"}-${kind}`, audio ? 6 : 15);
      assert.equal(original.generators.length, 1);
      assert.equal(original.precompositionBundle, null);
      for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"]) {
        const scale = aa === "ssaa4x" ? 4 : aa === "ssaa2x" ? 2 : 1;
        const header = structuredClone(original.plans.scene.metadata.header);
        header.aa = aa;
        header.render_target = {
          width: header.target.width * scale,
          height: header.target.height * scale,
        };
        const stage = (p) => {
          const copy = structuredClone(p);
          copy.metadata.header = structuredClone(header);
          return copy;
        };
        const scene = stage(original.plans.scene),
          rootPlan = stage(original.plans.root),
          post = stage(original.plans.post);
        const postView = new DataView(
          post.blobs[0].buffer,
          post.blobs[0].byteOffset,
          post.blobs[0].byteLength,
        );
        postView.setFloat32(0, header.render_target.width, true);
        postView.setFloat32(4, header.render_target.height, true);
        const generators = structuredClone(original.generators);
        for (const generator of generators) {
          const view = new DataView(
            generator.context.buffer,
            generator.context.byteOffset,
            generator.context.byteLength,
          );
          view.setFloat32(0, header.render_target.width, true);
          view.setFloat32(4, header.render_target.height, true);
        }
        const draws = rootPlan.metadata.slices[0].draws.map(
          ({ instance_id, first_vertex, vertex_count, texture }) => ({
            instance_id,
            first_vertex,
            vertex_count,
            texture,
          }),
        );
        const vertexCount = scene.metadata.slices[0].vertex_count;
        const ids = Uint32Array.from({ length: draws.length * 2 }, (_, i) => 123 + i);
        for (const mode of [
          "normal",
          "objectId",
          "materialId",
          "worldPosition",
          "motionVector",
          "beauty",
          "beauty-motion",
          "depthOfField",
          "empty",
        ]) {
          const motion = mode === "beauty-motion",
            tier = mode === "depthOfField" ? 2 : -1;
          const auxiliary = m.buildAuxiliaryPlan(
            header,
            {
              status: "drawn",
              tier,
              vertex_count: vertexCount,
              draws,
              generators:
                mode === "empty"
                  ? []
                  : generators
                      .filter((g) => g.program.graph.render_variants[g.variantIndex].auxiliary)
                      .map((g) => m.compositionIdentityFromString(g.instanceId)),
            },
            ids,
            new Float32Array(vertexCount * 2),
          );
          const motionPlan = m.buildMotionReconstructionPlan(header, {
            requested: motion,
            resourcesAvailable: true,
            settings: motionSettings,
            shutter: { openTime: 0.49, duration: 0.02 },
            compositionWidth: header.target.width,
          });
          const output = m.buildFinalOutputPlan(header, {
            visualization: mode === "empty" ? "normal" : motion ? "beauty" : mode,
            auxiliaryValid: true,
            beautyDepthOfField: false,
            motionBlurValid: motion,
            motionBlurBindingAvailable: motion,
          });
          let effect = null;
          if (tier === 2) {
            const bytes = new Uint8Array(depth.blobs[0]),
              view = new DataView(bytes.buffer);
            view.setFloat32(0, header.render_target.width, true);
            view.setFloat32(4, header.render_target.height, true);
            view.setFloat32(68, view.getFloat32(68, true) * scale, true);
            view.setFloat32(72, tier, true);
            effect = m.buildPostEffectPlan(
              header,
              {
                kind: "depth",
                mode: "depthOfField",
                inputs: [
                  "scene",
                  "worldPosition",
                  "transparentWorldPosition",
                  "peeledWorldPosition",
                  "frontLayerColor",
                  "peeledLayerColor",
                ],
              },
              true,
              bytes,
            );
          }
          const bundle = m.buildFrameBundle({
            scene,
            root: rootPlan,
            post,
            output: {
              output,
              motion: motionPlan,
              auxiliary: mode === "beauty" ? null : auxiliary,
              effect,
            },
            shadowMapSize: original.shadowMapSize,
            effects: new Map(
              [...original.effects].map(([id, e]) => [id, { ...e, execution: stage(e.execution) }]),
            ),
            generators: generators.map((plan) => ({ plan, capacity: plan.capacity })),
            resources,
          });
          frames.push({
            id: `${kind}-${aa}-${mode}`,
            kind,
            aa,
            mode,
            motion,
            tier,
            width: header.target.width,
            height: header.target.height,
            source: { path: source, sha256: await hashFile(join(root, source)) },
            plan: Array.from(m.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
            resources: bundle.resources.map((r) => ({
              message: r.message,
              bytes: Array.from(r.bytes),
            })),
          });
        }
      }
    }
    return frames;
  } finally {
    await server.close();
  }
}
