import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

/** Add diagnostic output controls to unchanged, already-frozen production geometry. */
export async function surfaceFrameFixtures(root) {
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
    ])
      Object.assign(modules, await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    const controls = await server.ssrLoadModule("/src/renderer/effects/surface-post-effects.ts");
    const base = "artifacts/parity/runs/2026-10-05T21-43-24-957Z-fefdc50f/candidate";
    const frames = [];
    for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"]) {
      const source = `${base}/aa-${aa}`;
      const messages = JSON.parse(await readFile(join(root, source, "15/resources.json"), "utf8"));
      const resources = await Promise.all(
        messages.map(async (message) => ({
          message,
          bytes: new Uint8Array(
            await readFile(join(root, source, "frame-resources", `${message.hash}.bin`)),
          ),
        })),
      );
      const bytes = await readFile(join(root, source, "15/replay.fpln"));
      const original = { plan: modules.decodeFramePlan(new Uint8Array(bytes)), resources };
      const decoded = modules.readFrameBundle(original);
      const { scene, post, root: commands } = decoded.plans;
      const header = scene.metadata.header;
      const sceneSlice = modules.prepareSceneBuffers(scene).slice;
      const draws = commands.metadata.slices[0].draws.map(
        ({ instance_id, first_vertex, vertex_count, texture }) => ({
          instance_id,
          first_vertex,
          vertex_count,
          texture,
        }),
      );
      assert(draws.every((d) => d.texture.kind === "none"));
      const ids = Uint32Array.from({ length: draws.length * 2 }, (_, i) =>
        i % 2 ? 29 : 0xfedcba98,
      );
      const motion = Float32Array.from({ length: sceneSlice.vertex_count * 2 }, (_, i) =>
        i % 2 ? 0.0125 : -0.075,
      );
      for (const mode of ["selectionIsolation", "vectorMotionBlur"]) {
        for (const status of ["ready", "skipped"]) {
          const auxiliary = modules.buildAuxiliaryPlan(
            header,
            {
              status: "drawn",
              tier: -1,
              vertex_count: sceneSlice.vertex_count,
              draws,
              generators: [],
            },
            ids,
            motion,
          );
          const effect = modules.buildPostEffectPlan(
            header,
            { kind: "surface", mode, inputs: ["scene", "objectId", "motionVector"] },
            status === "ready",
            new Uint8Array(
              controls.buildSurfacePostUniforms(
                mode,
                header.render_target.width,
                header.render_target.height,
                0xfedcba98,
                1.5,
              ),
            ),
          );
          const output = modules.buildFinalOutputPlan(header, {
            visualization: mode,
            auxiliaryValid: true,
            beautyDepthOfField: false,
            motionBlurValid: false,
            motionBlurBindingAvailable: false,
          });
          // A nonzero clear makes a captured skip distinguishable from empty or stale output.
          new Float32Array(output.blobs[0].buffer).set([0.125, 0.25, 0.5, 0.75]);
          const bundle = modules.buildFrameBundle({
            scene,
            root: commands,
            post,
            output: { output, motion: decoded.plans.output.motion, auxiliary, effect },
            shadowMapSize: decoded.shadowMapSize,
            effects: decoded.effects,
            generators: [],
            resources,
          });
          frames.push({
            id: `${mode}-${aa}-${status}`,
            source: `${source}/15/replay.fpln`,
            width: header.target.width,
            height: header.target.height,
            plan: Array.from(modules.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
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
