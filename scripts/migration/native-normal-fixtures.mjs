import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { materialFixtures } from "./native-material-fixtures.mjs";

/** Reuse authenticated browser encodings, including fractional and zero alpha. */
export async function normalFixtures(root, encodedCapture, provided = false) {
  const source = await materialFixtures(root);
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
    const capture = JSON.parse(
      await readFile(join(encodedCapture, provided ? "provided.json" : "gpu.json"), "utf8"),
    );
    assert.equal(capture.status, "passed");
    const messages = provided
      ? capture.fixtures.map((f) => ({ type: "put_resource", ...f.message }))
      : JSON.parse(await readFile(join(encodedCapture, "input.json"), "utf8"));
    assert.deepEqual(
      messages.map((m) => m.descriptor.encoding),
      provided ? ["webp", "webp", "webp"] : ["png", "jpeg", "webp"],
    );
    const normals = await Promise.all(
      messages.map(async (message, index) => ({
        message,
        variant: provided ? capture.fixtures[index].id : null,
        bytes: provided
          ? new Uint8Array(Buffer.from(capture.fixtures[index].encoded, "base64"))
          : new Uint8Array(await readFile(join(encodedCapture, "payloads", `${message.hash}.bin`))),
      })),
    );
    const frames = [];
    for (const light of provided ? ["directional"] : ["directional", "point", "spot"])
      for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"])
        for (const normal of normals)
          for (const mode of provided
            ? ["normal", "zero"]
            : ["normal", "negative", "zero", "combined"]) {
            const input = source.find(
              (f) =>
                f.light === light &&
                f.aa === aa &&
                f.mode === (mode === "combined" ? "hdr" : "fallback"),
            );
            const resources = input.resources.map((r) => ({
              message: r.message,
              bytes: new Uint8Array(r.bytes),
            }));
            const original = modules.readFrameBundle({
              plan: modules.decodeFramePlan(new Uint8Array(input.plan)),
              resources,
            });
            const rootPlan = original.plans.root;
            for (const material of rootPlan.metadata.slices.filter(
              (s) => s.kind === "material_binding",
            )) {
              material.normal = { kind: "texture", hash: normal.message.hash };
              const b = rootPlan.blobs[material.blob_index];
              new DataView(b.buffer, b.byteOffset, b.byteLength).setFloat64(
                0,
                mode === "negative" ? -0.7 : mode === "zero" ? 0 : 0.7,
                true,
              );
            }
            rootPlan.metadata.resources = [
              ...rootPlan.metadata.resources,
              normal.message.hash,
            ].sort();
            const bundle = modules.buildFrameBundle({
              ...original.plans,
              root: rootPlan,
              shadowMapSize: original.shadowMapSize,
              effects: original.effects,
              generators: [],
              resources: [...resources, normal],
            });
            const encoding = normal.message.descriptor.encoding;
            frames.push({
              id: `${light}-${aa}-${normal.variant ?? encoding}-${mode}`,
              light,
              aa,
              encoding,
              ...(provided ? { variant: normal.variant } : {}),
              mode,
              width: input.width,
              height: input.height,
              normal: normal.message.hash,
              source: input.source,
              plan: Array.from(modules.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
              resources: bundle.resources.map((r) => ({
                message: r.message,
                bytes: Array.from(r.bytes),
              })),
            });
          }
    return frames;
  } finally {
    await server.close();
  }
}
