import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { hashFile } from "./source.mjs";

/** Exercise child-first routing using frozen geometry and supplied generator invocations. */
export async function generatorSurfaceFixtures(root) {
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
      "generator-plan",
      "precomposition-bundle-read",
      "precomposition-bundle-plan",
      "precomposition-graph-plan",
      "composition-identity",
    ])
      Object.assign(m, await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    const ledger = JSON.parse(
      await readFile(join(root, "docs/migration/rust-renderer-progress.json"), "utf8"),
    );
    const pin = ledger.milestones.find((v) => v.id === "M3").input_manifest;
    assert.equal(await hashFile(join(root, pin.path)), pin.sha256);
    const base = pin.path.replace(/\/manifest.json$/, "");
    const read = async (id, frame) => {
      const path = `${base}/${id}/${frame}/replay.fpln`;
      const messages = JSON.parse(
        await readFile(join(root, base, id, `${frame}/resources.json`), "utf8"),
      );
      const resources = await Promise.all(
        messages.map(async (message) => ({
          message,
          bytes: new Uint8Array(
            await readFile(join(root, base, id, "frame-resources", `${message.hash}.bin`)),
          ),
        })),
      );
      return {
        source: { path, sha256: await hashFile(join(root, path)) },
        resources,
        frame: m.readFrameBundle({
          plan: m.decodeFramePlan(new Uint8Array(await readFile(join(root, path)))),
          resources,
        }),
      };
    };
    const baseFrame = await read("nested-precompositions", 15);
    const original = baseFrame.frame;
    const decoded = m.readPrecompositionBundle(
      original.precompositionBundle.plan,
      original.precompositionBundle.resources,
    );
    assert.equal(decoded.plans.length, 1);
    const frames = [];
    for (const kind of ["billboard", "mesh", "streak", "bars", "ring", "scope"]) {
      const audio = ["bars", "ring", "scope"].includes(kind);
      const invocation = await read(
        `scene-${audio ? "audio-spectrum" : "particles"}-${kind}`,
        audio ? 6 : 15,
      );
      const modes = [
        "child",
        "nested",
        "unavailable",
        ...(audio ? ["shared", "inherited", "silent", "conflict"] : []),
      ];
      for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"])
        for (const mode of modes) {
          const header = structuredClone(original.plans.scene.metadata.header);
          const scale = aa === "ssaa4x" ? 4 : aa === "ssaa2x" ? 2 : 1;
          header.aa = aa;
          header.render_target = {
            width: header.target.width * scale,
            height: header.target.height * scale,
          };
          const stage = (plan) => {
            const p = structuredClone(plan);
            p.metadata.header = structuredClone(header);
            if (
              ["motion_reconstruction_slice_v1", "layer_effects_slice_v1"].includes(
                p.metadata.contract_level,
              )
            ) {
              const v = new DataView(
                p.blobs[0].buffer,
                p.blobs[0].byteOffset,
                p.blobs[0].byteLength,
              );
              v.setFloat32(0, header.render_target.width, true);
              v.setFloat32(4, header.render_target.height, true);
            }
            return p;
          };
          const scene = stage(original.plans.scene),
            rootPlan = stage(original.plans.root),
            post = stage(original.plans.post);
          const postData = new DataView(
            post.blobs[0].buffer,
            post.blobs[0].byteOffset,
            post.blobs[0].byteLength,
          );
          postData.setFloat32(0, header.render_target.width, true);
          postData.setFloat32(4, header.render_target.height, true);
          const leaf = structuredClone(decoded.plans[0]);
          const generator = structuredClone(invocation.frame.generators[0]);
          generator.instanceId = `child-generator-${kind}`;
          if (mode === "silent") generator.audio.fill(0, 32);
          leaf.generators = [
            {
              instanceId: generator.instanceId,
              origin: { layerName: `Child ${kind}`, pluginId: "bundled" },
              execution:
                mode === "unavailable"
                  ? { status: "unavailable" }
                  : {
                      status: "ready",
                      capacity: generator.capacity,
                      effective_count: generator.effectiveCount,
                    },
              plan: m.buildGeneratorSlice(
                { ...leaf.scene.metadata.header, snapshot_scope: "precomposition-generators" },
                generator,
              ),
              shaders: generator.program.shaders,
            },
          ];
          if (mode !== "unavailable")
            leaf.commands.push(
              {
                kind: "begin_scene",
                group: "generator",
                color: { loadOp: "load", storeOp: "store", clearValue: [0, 0, 0, 0] },
                depth: { loadOp: "clear", storeOp: "store", clearValue: 1 },
              },
              {
                kind: "generator",
                instanceId: generator.instanceId,
                blendMode: generator.blendMode,
              },
              { kind: "end_scene" },
            );
          const plans = [leaf];
          if (mode === "nested") {
            const parent = structuredClone(decoded.plans[0]);
            leaf.target.id += "-leaf";
            parent.draws[0].texture = { kind: "surface", targetId: leaf.target.id };
            plans.push(parent);
          }
          const graph = m.buildPrecompositionGraph(
            leaf.scene.metadata.header,
            plans.map((p) => ({
              target: p.target,
              drawTargets: p.draws.map((d) =>
                d.texture.kind === "surface" ? d.texture.targetId : undefined,
              ),
            })),
            decoded.graph.bindings,
          );
          const precompositions = m.buildPrecompositionBundle(graph, plans, []);
          const roots = [];
          if (["shared", "inherited", "conflict"].includes(mode)) {
            const sibling = structuredClone(generator);
            sibling.instanceId = `root-generator-${kind}`;
            if (mode === "inherited") sibling.audio = undefined;
            if (mode === "conflict") sibling.audio[100] ^= 1;
            roots.push({ plan: sibling, capacity: sibling.capacity });
            rootPlan.metadata.slices[0].commands.push(
              {
                kind: "begin_scene",
                group: "generator",
                color_load: "load",
                color_store: "store",
                depth_load: "clear",
                depth_store: "store",
                clear_index: rootPlan.blobs[0].byteLength / 40,
              },
              {
                kind: "generator",
                instance_id: m.compositionIdentityFromString(sibling.instanceId),
                blend_mode: sibling.blendMode,
              },
              { kind: "end_scene" },
            );
            const clears = new Uint8Array(rootPlan.blobs[0].byteLength + 40);
            clears.set(rootPlan.blobs[0]);
            new DataView(clears.buffer).setFloat64(clears.byteLength - 8, 1, true);
            rootPlan.blobs[0] = clears;
            rootPlan.metadata.blobs[0].byte_length = clears.length;
            rootPlan.metadata.blobs[0].element_count = clears.length;
            let offset = 0;
            for (const blob of rootPlan.metadata.blobs) {
              blob.byte_offset = offset;
              offset = Math.ceil((offset + blob.byte_length) / 16) * 16;
            }
          }
          const bundle = m.buildFrameBundle({
            scene,
            root: rootPlan,
            post,
            output: Object.fromEntries(
              Object.entries(original.plans.output).map(([key, p]) => [key, p ? stage(p) : null]),
            ),
            shadowMapSize: original.shadowMapSize,
            effects: new Map(
              [...original.effects].map(([id, e]) => [
                id,
                {
                  ...e,
                  execution: stage(e.execution),
                  ...(e.status === "ready" ? { plan: stage(e.plan) } : {}),
                },
              ]),
            ),
            generators: roots,
            resources: [...baseFrame.resources, ...invocation.resources],
            precompositions,
          });
          m.readFrameBundle(bundle);
          frames.push({
            id: `${kind}-${aa}-${mode}`,
            kind,
            aa,
            mode,
            source: baseFrame.source,
            generator_source: invocation.source,
            width: header.target.width,
            height: header.target.height,
            plan: Array.from(m.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
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
