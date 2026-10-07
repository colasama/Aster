import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { hashFile } from "./source.mjs";

/** Mutate only supplied audio and sibling identity; retain the frozen executable graph. */
export async function generatorAudioFixtures(root, base) {
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const modules = {};
    for (const name of ["codec", "frame-bundle-read", "frame-bundle-plan", "composition-identity"])
      Object.assign(modules, await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    const frames = [];
    for (const kind of ["bars", "ring", "scope"]) {
      const caseId = `scene-audio-spectrum-${kind}`;
      const source = `${base}/${caseId}/6/replay.fpln`;
      const packets = JSON.parse(
        await readFile(join(root, base, caseId, "6/resources.json"), "utf8"),
      );
      const resources = await Promise.all(
        packets.map(async (message) => ({
          message,
          bytes: new Uint8Array(
            await readFile(join(root, base, caseId, "frame-resources", `${message.hash}.bin`)),
          ),
        })),
      );
      const original = modules.readFrameBundle({
        plan: modules.decodeFramePlan(new Uint8Array(await readFile(join(root, source)))),
        resources,
      });
      assert.equal(original.generators.length, 1);
      assert(original.generators[0].audio);
      assert.equal(original.precompositionBundle, null);
      for (const mode of ["silent", "shared", "inherited", "conflict"]) {
        const generators = structuredClone(original.generators);
        const commands = structuredClone(original.plans.root);
        if (mode === "silent") generators[0].audio.fill(0, 32);
        else {
          const sibling = structuredClone(generators[0]);
          sibling.instanceId = "a-shared-audio-sibling";
          const context = new DataView(
            sibling.context.buffer,
            sibling.context.byteOffset,
            sibling.context.byteLength,
          );
          context.setFloat32(32, context.getFloat32(32, true) + 45, true);
          if (mode === "inherited") sibling.audio = undefined;
          if (mode === "conflict") sibling.audio[100] ^= 1;
          generators.push(sibling);
          const slice = commands.metadata.slices[0];
          slice.commands = slice.commands.flatMap((c) =>
            c.kind === "generator"
              ? [
                  c,
                  { ...c, instance_id: modules.compositionIdentityFromString(sibling.instanceId) },
                ]
              : [c],
          );
        }
        const bundle = modules.buildFrameBundle({
          scene: original.plans.scene,
          root: commands,
          post: original.plans.post,
          output: original.plans.output,
          shadowMapSize: original.shadowMapSize,
          effects: original.effects,
          generators: generators.map((plan) => ({ plan, capacity: plan.capacity })),
          resources,
        });
        frames.push({
          id: `${kind}-${mode}`,
          case_id: caseId,
          frame: 6,
          mode,
          source: { path: source, sha256: await hashFile(join(root, source)) },
          plan: new Uint8Array(modules.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
          resources: bundle.resources,
        });
      }
    }
    return frames;
  } finally {
    await server.close();
  }
}
