import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

async function inputs(context, reader, original) {
  const runtime = await loadIrRuntime(context.root);
  try {
    const plan = runtime.decodeFramePlan((await reader.bytes(original.input)).bytes);
    const messages = (await reader.json(`${dirname(original.input)}/resources.json`)).filter((m) =>
      plan.metadata.resources.includes(m.hash),
    );
    const packets = [];
    for (const message of messages)
      packets.push({
        message,
        bytes: new Uint8Array(
          (
            await reader.bytes(
              `${dirname(dirname(original.input))}/frame-resources/${message.hash}.bin`,
            )
          ).bytes,
        ),
      });
    const results = [];
    for (const id of ["timestamp-mismatch", "outside-duration", "neighbor-frame"]) {
      const bundle = structuredClone({ plan, resources: packets }),
        changes = new Map();
      const frame = bundle.resources.find((p) => p.message.kind === "media_frame");
      assert.equal(frame.message.descriptor.sample.kind, "video");
      const before = frame.message.hash;
      if (id === "timestamp-mismatch")
        frame.message.descriptor.sample.uploaded_time = { kind: "rational", value: 1, scale: 1 };
      else
        for (const key of ["requested_time", "uploaded_time"])
          frame.message.descriptor.sample[key] =
            id === "outside-duration"
              ? { kind: "rational", value: 4, scale: 1 }
              : { kind: "rational", value: 1001, scale: 24000 };
      frame.message.hash = runtime.contentResourceHashSync(frame.message, frame.bytes);
      changes.set(before, frame.message.hash);
      const replace = (value) =>
        JSON.parse(
          JSON.stringify(value, (_key, item) => {
            while (typeof item === "string" && changes.has(item)) item = changes.get(item);
            return item;
          }),
        );
      for (let pass = 0; pass <= bundle.resources.length; pass++) {
        let changed = false;
        for (const packet of bundle.resources) {
          if (
            packet.message.kind !== "buffer" ||
            Buffer.from(packet.bytes.subarray(0, 4)).toString() !== "FPLN"
          )
            continue;
          const stage = runtime.decodeFramePlan(packet.bytes),
            metadata = replace(stage.metadata);
          if (JSON.stringify(metadata) === JSON.stringify(stage.metadata)) continue;
          metadata.resources.sort();
          const old = packet.message.hash;
          packet.bytes = new Uint8Array(runtime.encodeFramePlan(metadata, stage.blobs));
          packet.message.descriptor.element_count = packet.bytes.length;
          packet.message.descriptor.byte_length = packet.bytes.length;
          packet.message.hash = runtime.contentResourceHashSync(packet.message, packet.bytes);
          changes.set(old, packet.message.hash);
          changed = true;
        }
        if (!changed) break;
        assert(pass < bundle.resources.length, "Video control dependency rewrite did not settle");
      }
      bundle.plan.metadata = replace(bundle.plan.metadata);
      bundle.plan.metadata.resources.sort();
      bundle.resources.sort((a, b) => a.message.hash.localeCompare(b.message.hash));
      runtime.readFrameBundle(bundle);
      const dir = join(context.output, "controls", id);
      await mkdir(dir, { recursive: true });
      const file = join(dir, "plan.fpln");
      await writeFile(file, runtime.encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs), {
        flag: "wx",
      });
      await writeAtomicJson(
        join(dir, "resources.json"),
        bundle.resources.map((p) => p.message),
      );
      for (const p of bundle.resources)
        await writeFile(join(dir, `${p.message.hash}.bin`), p.bytes, { flag: "wx" });
      results.push({ id, plan: file, resources: dir });
    }
    return results;
  } finally {
    await runtime.close();
  }
}

export async function runNativeVideoControls(
  context,
  { reader, original, binary, common },
  execute,
) {
  const results = [];
  for (const input of await inputs(context, reader, original)) {
    const output = join(input.resources, "frame.png"),
      negative = input.id !== "neighbor-frame";
    const step = await execute(
      {
        id: `video-control-${input.id}`,
        file: binary,
        args: [
          "render-plan",
          "--plan",
          input.plan,
          "--resources",
          input.resources,
          "--out",
          output,
          ...common,
        ],
        timeout_ms: 120_000,
      },
      context,
    );
    if (negative) {
      assert.equal(step.exit_code, 2);
      const error = JSON.parse(
        (await readFile(join(context.root, step.log), "utf8")).trim().split(/\r?\n/).at(-1),
      );
      assert.match(
        error.error,
        input.id === "timestamp-mismatch"
          ? /frame identities differ/
          : /outside a presentation interval/,
      );
      await assert.rejects(stat(output), { code: "ENOENT" });
      results.push({ id: input.id, rejected: true, output_absent: true, step });
    } else {
      assert.equal(step.status, "passed");
      const manifest = join(input.resources, "candidate.json");
      await writeAtomicJson(manifest, {
        schema_version: 1,
        frames: [
          {
            case_id: original.item.id,
            frame: original.frame,
            path: "frame.png",
            png_sha256: await hashFile(output),
          },
        ],
      });
      const gate = await runPixelGate(
        { ...context, output: join(input.resources, "pixels") },
        { manifestPath: manifest, scope: "diagnostic", profileOverride: "decode" },
        execute,
      );
      assert.equal(gate.status, "failed");
      assert.equal(gate.comparisons.length, 1);
      assert.equal(gate.comparisons[0].comparison.sequence.passed, false);
      results.push({
        id: input.id,
        rejected_by_pixel_oracle: true,
        step,
        pixel_gate: gate,
        candidate: relative(context.root, output).replaceAll("\\", "/"),
      });
    }
  }
  return results;
}
