import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { hashFile } from "./source.mjs";

/** Activate real HDR resources over supplied mesh geometry, independently of native execution. */
export async function materialFixtures(root) {
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const modules = {};
    for (const name of ["codec", "frame-bundle-read", "frame-bundle-plan", "resources"])
      Object.assign(modules, await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    const ledger = JSON.parse(
      await readFile(join(root, "docs/migration/rust-renderer-progress.json"), "utf8"),
    );
    const pin = ledger.milestones.find((m) => m.id === "M3").input_manifest;
    assert.equal(await hashFile(join(root, pin.path)), pin.sha256);
    const base = pin.path.replace(/\/manifest.json$/, "");
    const textures = [0, 1].map((generation) => {
      const bytes = new Uint8Array(8 * 4 * 8),
        view = new DataView(bytes.buffer);
      const values = [0x3400, 0x3800, 0x3c00, 0x4000, 0x4400];
      for (let i = 0; i < 8 * 4; i++) {
        for (let c = 0; c < 3; c++)
          view.setUint16(
            i * 8 + c * 2,
            values[(i * (generation + 1) + c + generation * 2) % values.length],
            true,
          );
        view.setUint16(i * 8 + 6, 0x3c00, true);
      }
      const content = {
        kind: "texture_pixels",
        descriptor: { dimension: "2d", width: 8, height: 4, depth: 1, format: "rgba16float" },
      };
      return {
        bytes,
        message: {
          type: "put_resource",
          ...content,
          hash: modules.contentResourceHashSync(content, bytes),
        },
      };
    });
    const frames = [];
    for (const light of ["directional", "point", "spot"]) {
      const source = `${base}/scene-lighting-${light}`;
      const messages = JSON.parse(await readFile(join(root, source, "0/resources.json"), "utf8"));
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
          new Uint8Array(await readFile(join(root, source, "0/replay.fpln"))),
        ),
        resources,
      });
      assert([...original.effects.values()].every((e) => e.status !== "ready"));
      for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"]) {
        const scale = aa === "ssaa4x" ? 4 : aa === "ssaa2x" ? 2 : 1;
        for (const mode of ["fallback", "hdr", "rotated", "replaced", "unshadowed"]) {
          const header = structuredClone(original.plans.scene.metadata.header);
          header.aa = aa;
          header.render_target = {
            width: header.target.width * scale,
            height: header.target.height * scale,
          };
          const stage = (input) => {
            if (!input) return null;
            const p = structuredClone(input);
            p.metadata.header = structuredClone(header);
            if (p.metadata.contract_level === "motion_reconstruction_slice_v1") {
              const b = p.blobs[0],
                v = new DataView(b.buffer, b.byteOffset, b.byteLength);
              v.setFloat32(0, header.render_target.width, true);
              v.setFloat32(4, header.render_target.height, true);
            }
            return p;
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
          const active = !["fallback", "unshadowed"].includes(mode),
            texture = textures[Number(mode === "replaced")];
          for (const material of rootPlan.metadata.slices.filter(
            (s) => s.kind === "material_binding",
          )) {
            assert.equal(material.normal.kind, "fallback");
            material.environment = active
              ? { kind: "texture", hash: texture.message.hash }
              : { kind: "fallback" };
            const bytes = rootPlan.blobs[material.blob_index],
              view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            view.setFloat64(8, active ? 0.55 : 0, true);
            view.setFloat64(16, mode === "rotated" ? 0.375 : 0, true);
          }
          rootPlan.metadata.resources = active ? [texture.message.hash] : [];
          if (mode === "unshadowed") {
            scene.metadata.slices[0].shadows_enabled = false;
            const b = scene.blobs[0];
            new DataView(b.buffer, b.byteOffset, b.byteLength).setFloat32(56, 0, true);
          }
          const bundle = modules.buildFrameBundle({
            scene,
            root: rootPlan,
            post,
            output: {
              motion: stage(original.plans.output.motion),
              output: stage(original.plans.output.output),
              auxiliary: stage(original.plans.output.auxiliary),
              effect: stage(original.plans.output.effect),
            },
            shadowMapSize: original.shadowMapSize,
            effects: new Map(
              [...original.effects].map(([id, e]) => [id, { ...e, execution: stage(e.execution) }]),
            ),
            generators: [],
            resources: [...resources, ...textures],
          });
          frames.push({
            id: `${light}-${aa}-${mode}`,
            light,
            aa,
            mode,
            width: header.target.width,
            height: header.target.height,
            source: `${source}/0/replay.fpln`,
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
