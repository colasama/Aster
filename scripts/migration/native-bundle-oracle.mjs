import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureBundleOracle(root, output) {
  const sources = await Promise.all(
    [
      "scripts/migration/native-bundle-oracle.mjs",
      "src/renderer/frame-plan/frame-bundle-fixture.ts",
      "src/renderer/frame-plan/frame-bundle-plan.ts",
      "src/renderer/frame-plan/frame-bundle-read.ts",
      "src/renderer/frame-plan/frame-bundle-media.ts",
      "src/renderer/frame-plan/frame-output-plans.ts",
      "src/renderer/frame-plan/post-effect-fixture.ts",
      "src/renderer/frame-plan/precomposition-bundle-fixture.ts",
      "src/renderer/frame-plan/precomposition-bundle-plan.ts",
      "src/renderer/frame-plan/precomposition-bundle-read.ts",
      "src/renderer/frame-plan/precomposition-bundle-resources.ts",
      "src/renderer/frame-plan/bundle-effect-records.ts",
      "src/renderer/frame-plan/generator-plan.ts",
      "src/renderer/frame-plan/codec.ts",
      "src/renderer/frame-plan/resources.ts",
      "src/renderer/media/media-pixel-payload.ts",
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
    const m = {};
    for (const name of [
      "frame-bundle-fixture",
      "frame-bundle-plan",
      "frame-bundle-read",
      "frame-bundle-media",
      "precomposition-bundle-fixture",
      "precomposition-bundle-plan",
      "precomposition-bundle-read",
      "generator-plan",
      "root-scene-plan",
      "composition-identity",
      "codec",
      "frame-output-plans",
      "post-effect-fixture",
      "auxiliary-plan",
    ])
      Object.assign(m, await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
    const plan = (p) =>
      p ? { metadata: p.metadata, blobs: p.blobs.map((b) => Array.from(b)) } : null;
    const packet = (r) => ({ message: r.message, bytes: Array.from(r.bytes) });
    const expected = (b) => ({
      plan: plan(b.plan),
      resources: b.resources.map((r) => ({
        message: r.message,
        byte_length: r.bytes.length,
        payload_sha256: sha256(r.bytes),
      })),
    });
    const effect = ([id, e]) => ({
      id: m.compositionIdentityFromString(id),
      status: e.status,
      execution: plan(e.execution),
      program: e.status === "ready" ? plan(e.plan) : null,
      lut: e.status === "ready" ? { ...packet(e.lut.resource), label: e.lut.resource.label } : null,
      error_utf16: e.status === "failed" ? units(e.error) : [],
    });
    const generator = (g) => ({
      id: m.compositionIdentityFromString(g.instanceId),
      plan: plan(g.plan),
      shaders: g.shaders.map(packet),
      layer_name_utf16: units(g.origin?.layerName ?? ""),
      plugin_id_utf16: units(g.origin?.pluginId ?? ""),
      execution: g.execution ?? { status: "planned" },
    });
    const pixels = (p) => ({ frame: p.frame.hash, pixels: packet(p.pixels) });
    const frames = [],
      surfaces = [],
      outputs = [];
    for (const fixture of m.frameBundleFixtures()) {
      const decoded = m.readFrameBundle(fixture.frameBundle);
      for (const shadowMapSize of [1, 1024, 16384]) {
        const input = {
          ...decoded.plans,
          shadowMapSize,
          effects: decoded.effects,
          generators: decoded.generators.map((p) => ({ plan: p, capacity: p.capacity })),
          resources: fixture.frameBundle.resources,
          precompositions: decoded.precompositionBundle ?? undefined,
        };
        const result = m.withFrameBundleMedia(m.buildFrameBundle(input), decoded.mediaPixels);
        frames.push({
          scene: plan(input.scene),
          root: plan(input.root),
          post: plan(input.post),
          output: Object.fromEntries(
            Object.entries(input.output).map(([key, value]) => [key, plan(value)]),
          ),
          shadow_map_size: shadowMapSize,
          effects: [...input.effects].map(effect),
          generators: input.generators.map(({ plan: p, capacity }) =>
            generator({
              instanceId: p.instanceId,
              plan: m.buildGeneratorSlice(input.output.output.metadata.header, p),
              shaders: p.program.shaders,
              execution: { status: "ready", capacity, effective_count: p.effectiveCount },
            }),
          ),
          resources: input.resources.map(packet),
          precompositions: input.precompositions
            ? {
                plan: plan(input.precompositions.plan),
                resources: input.precompositions.resources.map(packet),
              }
            : null,
          temporal: input.temporal.map(plan),
          media_pixels: decoded.mediaPixels.map(pixels),
          expected: expected(result),
        });
      }
    }
    for (const fixture of m.precompositionBundleFixtures()) {
      const decoded = m.readPrecompositionBundle(fixture.bundle.plan, fixture.bundle.resources);
      const lookup = new Map(fixture.bundle.resources.map((r) => [r.message.hash, r]));
      const records = fixture.bundle.plan.metadata.slices[0].scenes;
      const scenes = decoded.plans.map((s, i) => ({
        target_id: m.compositionIdentityFromString(s.target.id),
        label_utf16: units(s.label),
        scene: plan(s.scene),
        commands: plan(m.decodeFramePlan(lookup.get(records[i].commands).bytes)),
        draw_scene_indices: s.draws.map((d) => d.sceneDrawIndex),
        effects: [...s.effects].map(effect),
        generators: s.generators.map(generator),
      }));
      surfaces.push({
        graph: plan(
          m.decodeFramePlan(lookup.get(fixture.bundle.plan.metadata.slices[0].graph).bytes),
        ),
        scenes,
        resources: fixture.bundle.resources.map(packet),
        media_pixels: decoded.mediaPixels.map(pixels),
        expected: expected(fixture.bundle),
      });
    }
    const base = m.frameBundleFixtures()[1].input.output;
    const header = base.output.metadata.header;
    const routes = [
      { kind: "beauty", source: "scene" },
      { kind: "beauty", source: "motion_blur" },
      { kind: "depth", mode: "depthFog" },
      { kind: "depth", mode: "depthOfField" },
      { kind: "surface", mode: "selectionIsolation" },
      { kind: "surface", mode: "vectorMotionBlur" },
    ];
    const effects = [
      null,
      ...m.postEffectFixtures().map((f) => {
        const p = m.decodeFramePlan(f.bytes);
        p.metadata.header = structuredClone(header);
        return p;
      }),
    ];
    for (const auxiliaryStatus of [null, "unavailable", "cleared", "drawn"])
      for (const motionStatus of ["skipped", "ready"])
        for (const route of routes)
          for (const effect of effects) {
            const motion = structuredClone(base.motion),
              outputPlan = structuredClone(base.output);
            motion.metadata.slices[0].status = motionStatus;
            outputPlan.metadata.slices[0].route = route;
            const auxiliary = auxiliaryStatus
              ? m.buildAuxiliaryPlan(
                  header,
                  {
                    status: auxiliaryStatus,
                    tier: auxiliaryStatus === "unavailable" ? -1 : 2,
                    vertex_count: 0,
                    draws: [],
                    generators: [],
                  },
                  new Uint32Array(),
                )
              : null;
            const input = { auxiliary, motion, output: outputPlan, effect };
            let accepted = true;
            try {
              m.validateFrameOutputPlans(input);
            } catch {
              accepted = false;
            }
            outputs.push({
              input: Object.fromEntries(
                Object.entries(input).map(([key, value]) => [key, plan(value)]),
              ),
              accepted,
            });
          }
    assert(frames.length >= 9 && surfaces.length >= 1);
    for (const source of sources)
      assert.equal(sha256(await readFile(join(root, source.path))), source.sha256);
    await writeAtomicJson(output, { version: 1, sources, frames, surfaces, outputs });
    return {
      cases: frames.length + surfaces.length,
      frames: frames.length,
      surfaces: surfaces.length,
      output_controls: outputs.length,
      scope: "native-bundle-assembly-from-authenticated-component-inputs",
      whole_project_plan_parity: false,
    };
  } finally {
    await server.close();
  }
}
