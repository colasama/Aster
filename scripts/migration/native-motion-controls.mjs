import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function motionControlInputs(context, reader, original) {
  const runtime = await loadIrRuntime(context.root);
  try {
    const plan = runtime.decodeFramePlan(
      (await reader.bytes(original.input.path, original.input.sha256)).bytes,
    );
    const messages = await reader.json(`${dirname(original.input.path)}/resources.json`);
    const resources = `${dirname(dirname(original.input.path))}/frame-resources`;
    const packets = [];
    for (const message of messages)
      packets.push({
        message,
        bytes: new Uint8Array((await reader.bytes(`${resources}/${message.hash}.bin`)).bytes),
      });
    const results = [];
    for (const id of ["zero-radius", "zero-vectors", "missing-auxiliary", "wrong-output"]) {
      const bundle = structuredClone({ plan, resources: packets });
      const envelope = bundle.plan.metadata.slices[0];
      if (id === "missing-auxiliary") {
        const hash = envelope.auxiliary;
        envelope.auxiliary = null;
        bundle.plan.metadata.resources = bundle.plan.metadata.resources.filter((h) => h !== hash);
        bundle.resources = bundle.resources.filter((p) => p.message.hash !== hash);
      } else {
        const key =
          id === "zero-radius" ? "motion" : id === "zero-vectors" ? "auxiliary" : "output";
        const packet = bundle.resources.find((p) => p.message.hash === envelope[key]);
        assert(packet);
        const stage = runtime.decodeFramePlan(packet.bytes);
        const slice = stage.metadata.slices[0];
        if (id === "zero-radius")
          new DataView(stage.blobs[0].buffer, stage.blobs[0].byteOffset).setFloat32(16, 0, true);
        else if (id === "zero-vectors") stage.blobs[0].fill(0, slice.draws.length * 8);
        else slice.route = { kind: "beauty", source: "scene" };
        const old = packet.message.hash;
        packet.bytes = new Uint8Array(runtime.encodeFramePlan(stage.metadata, stage.blobs));
        packet.message.descriptor.element_count = packet.bytes.length;
        packet.message.descriptor.byte_length = packet.bytes.length;
        packet.message.hash = runtime.contentResourceHashSync(packet.message, packet.bytes);
        envelope[key] = packet.message.hash;
        bundle.plan.metadata.resources = bundle.plan.metadata.resources
          .map((h) => (h === old ? packet.message.hash : h))
          .sort();
      }
      const out = join(context.output, "controls", id);
      await mkdir(out, { recursive: true });
      await writeFile(
        join(out, "plan.fpln"),
        runtime.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs),
        { flag: "wx" },
      );
      await writeAtomicJson(
        join(out, "resources.json"),
        bundle.resources.map((p) => p.message),
      );
      for (const p of bundle.resources)
        await writeFile(join(out, `${p.message.hash}.bin`), p.bytes, { flag: "wx" });
      results.push({ id, plan: join(out, "plan.fpln"), resources: out });
    }
    return results;
  } finally {
    await runtime.close();
  }
}
