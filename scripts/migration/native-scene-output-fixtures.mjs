import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { hashFile } from "./source.mjs";

/** Exercise supplied output routes over frozen camera geometry, without project evaluation. */
export async function sceneOutputFixtures(root) {
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const modules = {};
    for (const name of [
      "codec",
      "frame-bundle-read",
      "frame-bundle-plan",
      "auxiliary-plan",
      "post-effect-plan",
      "final-output-plan",
      "scene-buffer-upload",
      "motion-reconstruction-plan",
    ])
      Object.assign(modules, await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    const { motionSettings } = await server.ssrLoadModule(
      "/tests/parity/output-replay/fixtures.ts",
    );
    const ledger = JSON.parse(
      await readFile(join(root, "docs/migration/rust-renderer-progress.json"), "utf8"),
    );
    const milestone = ledger.milestones.find((m) => m.id === "M3");
    const base = milestone.input_manifest.path.replace(/\/manifest.json$/, "");
    assert.equal(
      await hashFile(join(root, milestone.input_manifest.path)),
      milestone.input_manifest.sha256,
    );
    const source = `${base}/scene-dof-55`;
    const messages = JSON.parse(await readFile(join(root, source, "15/resources.json"), "utf8"));
    const resources = await Promise.all(
      messages.map(async (message) => ({
        message,
        bytes: new Uint8Array(
          await readFile(join(root, source, "frame-resources", `${message.hash}.bin`)),
        ),
      })),
    );
    const original = modules.readFrameBundle({
      plan: modules.decodeFramePlan(
        new Uint8Array(await readFile(join(root, source, "15/replay.fpln"))),
      ),
      resources,
    });
    assert([...original.effects.values()].every((effect) => effect.status !== "ready"));
    const frames = [];
    for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"]) {
      const scale = aa === "ssaa4x" ? 4 : aa === "ssaa2x" ? 2 : 1;
      const header = structuredClone(original.plans.scene.metadata.header);
      header.aa = aa;
      header.render_target = {
        width: header.target.width * scale,
        height: header.target.height * scale,
      };
      const stage = (input) => {
        const copy = structuredClone(input);
        copy.metadata.header = structuredClone(header);
        return copy;
      };
      const scene = stage(original.plans.scene),
        rootPlan = stage(original.plans.root),
        post = stage(original.plans.post);
      const effects = new Map(
        [...original.effects].map(([id, effect]) => [
          id,
          {
            ...effect,
            execution: stage(effect.execution),
          },
        ]),
      );
      const postView = new DataView(
        post.blobs[0].buffer,
        post.blobs[0].byteOffset,
        post.blobs[0].byteLength,
      );
      postView.setFloat32(0, header.render_target.width, true);
      postView.setFloat32(4, header.render_target.height, true);
      const geometry = modules.prepareSceneBuffers(scene).slice;
      // Overlapping translucent cards make each supplied depth tier observable.
      const vertices = new DataView(
        scene.blobs[0].buffer,
        scene.blobs[0].byteOffset,
        scene.blobs[0].byteLength,
      );
      for (const [index, draw] of geometry.draws.entries()) {
        let center = 0;
        for (let i = draw.first_vertex; i < draw.first_vertex + draw.vertex_count; i++)
          center += vertices.getFloat32(592 + i * 160, true) / draw.vertex_count;
        for (let i = draw.first_vertex; i < draw.first_vertex + draw.vertex_count; i++) {
          const offset = 592 + i * 160;
          vertices.setFloat32(
            offset,
            vertices.getFloat32(offset, true) - center + (index - 1) * 0.08,
            true,
          );
          vertices.setFloat32(offset + 32, [0.45, 0.65, 0.9][index % 3], true);
        }
      }
      const draws = rootPlan.metadata.slices[0].draws.map(
        ({ instance_id, first_vertex, vertex_count, texture }) => ({
          instance_id,
          first_vertex,
          vertex_count,
          texture,
        }),
      );
      assert(draws.every((d) => d.texture.kind === "none"));
      const ids = Uint32Array.from({ length: draws.length * 2 }, (_, i) =>
        i % 2 ? 3 + Math.floor(i / 2) : 0xfedcba90 + Math.floor(i / 2),
      );
      const vectors = Float32Array.from({ length: geometry.vertex_count * 2 }, (_, i) =>
        i % 2 ? 0.0125 : -0.075,
      );
      const cases = [];
      for (const tier of [0, 1, 2])
        for (const motion of [false, true])
          cases.push({ mode: "depthOfField", tier, motion, ready: true });
      cases.push({ mode: "depthFog", tier: 0, motion: false, ready: true });
      cases.push({ mode: "depthOfField", tier: 0, motion: false, ready: false });
      for (const mode of [
        "linearColor",
        "luminance",
        "alpha",
        "normal",
        "objectId",
        "materialId",
        "worldPosition",
        "motionVector",
      ])
        cases.push({ mode, tier: -1, motion: false, ready: true });
      for (const c of cases) {
        const depth = c.mode.startsWith("depth"),
          sceneRole = c.motion ? "motion_blur" : "scene";
        const auxiliary = modules.buildAuxiliaryPlan(
          header,
          {
            status: "drawn",
            tier: c.tier,
            vertex_count: geometry.vertex_count,
            draws,
            generators: [],
          },
          ids,
          vectors,
        );
        const motion = modules.buildMotionReconstructionPlan(header, {
          requested: c.motion,
          resourcesAvailable: true,
          settings: motionSettings,
          shutter: { openTime: 0.49, duration: 0.02 },
          compositionWidth: header.target.width,
        });
        const output = modules.buildFinalOutputPlan(header, {
          visualization: c.mode,
          auxiliaryValid: true,
          beautyDepthOfField: false,
          motionBlurValid: c.motion,
          motionBlurBindingAvailable: c.motion,
        });
        new Float32Array(output.blobs[0].buffer).set([0.125, 0.25, 0.5, 0.75]);
        let effect = null;
        if (depth) {
          const bytes = new Uint8Array(original.plans.output.effect.blobs[0]);
          const view = new DataView(bytes.buffer);
          view.setFloat32(0, header.render_target.width, true);
          view.setFloat32(4, header.render_target.height, true);
          view.setFloat32(8, c.mode === "depthFog" ? 1 : 2, true);
          view.setFloat32(68, view.getFloat32(68, true) * scale, true);
          view.setFloat32(72, c.tier, true);
          effect = modules.buildPostEffectPlan(
            header,
            {
              kind: "depth",
              mode: c.mode,
              inputs: [
                sceneRole,
                "worldPosition",
                c.tier >= 1 ? "transparentWorldPosition" : "worldPosition",
                c.tier >= 2 ? "peeledWorldPosition" : "worldPosition",
                c.tier >= 1 ? "frontLayerColor" : sceneRole,
                c.tier >= 2 ? "peeledLayerColor" : sceneRole,
              ],
            },
            c.ready,
            bytes,
          );
        }
        const bundle = modules.buildFrameBundle({
          scene,
          root: rootPlan,
          post,
          output: { output, motion, auxiliary, effect },
          shadowMapSize: original.shadowMapSize,
          effects,
          generators: [],
          resources,
        });
        frames.push({
          id: `${c.mode}-${aa}-k${c.tier}-${c.motion ? "motion" : "still"}-${c.ready ? "ready" : "skipped"}`,
          ...c,
          aa,
          width: header.target.width,
          height: header.target.height,
          source: `${source}/15/replay.fpln`,
          plan: Array.from(modules.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
          resources: bundle.resources.map((r) => ({
            message: r.message,
            bytes: Array.from(r.bytes),
          })),
        });
      }
    }
    return frames;
  } finally {
    await server.close();
  }
}
