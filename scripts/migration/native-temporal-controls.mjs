import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Change supplied inputs while preserving their real content-addressed resource contract. */
export async function temporalControlInputs(context, reader, original) {
  const runtime = await loadIrRuntime(context.root);
  const inputs = [];
  try {
    const plan = runtime.decodeFramePlan(
      (await reader.bytes(original.plan.path, original.plan.sha256)).bytes,
    );
    const packets = [];
    for (const record of original.resources)
      packets.push({
        message: structuredClone(record.message),
        bytes: new Uint8Array(
          (
            await reader.bytes(
              `tests/parity/native-temporal-frame/resources/${record.message.hash}.bin`,
              record.sha256,
            )
          ).bytes,
        ),
      });
    for (const id of ["resolved-poison", "zero-exposure", "changed-sample", "surface-skip-route"]) {
      const bundle = structuredClone({ plan, resources: packets });
      const envelope = bundle.plan.metadata.slices[0];
      const temporal = bundle.resources.find((p) => p.message.hash === envelope.temporal[0]);
      assert(temporal);
      const pass = runtime.readTemporalPassSlice(runtime.decodeFramePlan(temporal.bytes));
      const replace = (packet, bytes) => {
        const old = packet.message.hash;
        packet.bytes = new Uint8Array(bytes);
        packet.message.descriptor.element_count = bytes.length;
        packet.message.descriptor.byte_length = bytes.length;
        packet.message.hash = runtime.contentResourceHashSync(packet.message, packet.bytes);
        return old;
      };
      if (id === "zero-exposure") {
        const stage = runtime.decodeFramePlan(temporal.bytes);
        const changed = runtime.buildTemporalPassSlice(stage.metadata.header, {
          ...pass,
          samples: pass.samples.map((s) => ({ ...s, weight: 0 })),
        });
        const old = replace(temporal, runtime.encodeFramePlan(changed.metadata, changed.blobs));
        envelope.temporal[0] = temporal.message.hash;
        bundle.plan.metadata.resources = bundle.plan.metadata.resources.filter((h) => h !== old);
        bundle.plan.metadata.resources.push(temporal.message.hash);
      } else if (id === "surface-skip-route") {
        const packet = bundle.resources.find((p) => p.message.hash === envelope.precompositions);
        const sub = runtime.decodeFramePlan(packet.bytes);
        const graphPacket = bundle.resources.find(
          (p) => p.message.hash === sub.metadata.slices[0].graph,
        );
        const graph = runtime.decodeFramePlan(graphPacket.bytes);
        new DataView(graph.blobs[0].buffer, graph.blobs[0].byteOffset).setUint32(16, 1, true);
        const oldGraph = replace(graphPacket, runtime.encodeFramePlan(graph.metadata, graph.blobs));
        sub.metadata.slices[0].graph = graphPacket.message.hash;
        sub.metadata.resources = sub.metadata.resources
          .map((h) => (h === oldGraph ? graphPacket.message.hash : h))
          .sort();
        const oldSub = replace(packet, runtime.encodeFramePlan(sub.metadata, sub.blobs));
        envelope.precompositions = packet.message.hash;
        bundle.plan.metadata.resources = bundle.plan.metadata.resources.map((h) =>
          h === oldGraph ? graphPacket.message.hash : h === oldSub ? packet.message.hash : h,
        );
      } else {
        const frame = id === "resolved-poison" ? pass.output : pass.samples[0].hash;
        const link = envelope.media_pixels.find((p) => p.frame === frame);
        assert(link);
        const pixel = bundle.resources.find((p) => p.message.hash === link.pixels);
        assert(pixel);
        // Clone because distinct samples may legitimately share a pixel resource.
        const changed = structuredClone(pixel);
        replace(changed, new Uint8Array(pixel.bytes.length));
        const old = link.pixels;
        link.pixels = changed.message.hash;
        if (!bundle.resources.some((p) => p.message.hash === changed.message.hash))
          bundle.resources.push(changed);
        if (!envelope.media_pixels.some((p) => p.pixels === old)) {
          bundle.resources = bundle.resources.filter((p) => p.message.hash !== old);
          bundle.plan.metadata.resources = bundle.plan.metadata.resources.filter((h) => h !== old);
        }
        bundle.plan.metadata.resources.push(changed.message.hash);
      }
      bundle.plan.metadata.resources = [...new Set(bundle.plan.metadata.resources)].sort();
      bundle.resources.sort((a, b) => a.message.hash.localeCompare(b.message.hash));
      if (id !== "surface-skip-route") runtime.readFrameBundle(bundle);
      const output = join(context.output, "controls", id);
      await mkdir(output, { recursive: true });
      const file = join(output, "plan.fpln");
      await writeFile(file, runtime.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs), {
        flag: "wx",
      });
      await writeAtomicJson(
        join(output, "resources.json"),
        bundle.resources.map((p) => p.message),
      );
      for (const packet of bundle.resources)
        await writeFile(join(output, `${packet.message.hash}.bin`), packet.bytes, { flag: "wx" });
      inputs.push({ id, plan: file, resources: output });
    }
  } finally {
    await runtime.close();
  }
  return inputs;
}
