import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auditBundleCapture } from "./ir-gate-bundle-capture.mjs";
import { mutate } from "./ir-gate-precomposition.mjs";

export async function auditFrameBundle(runtime, fixture, after, options) {
  const { context, cli, command, cliReport, outputFile } = options;
  const directory = join(context.output, fixture.id);
  await mkdir(directory);
  const packets = [],
    planHashes = new Set(runtime.frameBundlePlanResources(after.metadata.slices[0]));
  for (const packet of fixture.frameBundle.resources) {
    if (!planHashes.has(packet.message.hash)) continue;
    const plan = runtime.decodeFramePlan(packet.bytes);
    if (plan.metadata.contract_level === "precomposition_bundle_slice_v1") {
      for (const hash of runtime.precompositionPlanResources(plan.metadata.slices[0]))
        planHashes.add(hash);
    }
  }
  let nested = 0;
  for (const packet of fixture.frameBundle.resources) {
    let bytes = packet.bytes;
    if (planHashes.has(packet.message.hash)) {
      const input = join(directory, `${packet.message.hash}.input.fpln`),
        output = join(directory, `${packet.message.hash}.output.fpln`);
      await writeFile(input, bytes, { flag: "wx" });
      const step = await command(`ir-frame-stage-${fixture.id}-${nested++}`, cli, [
        "ir",
        "roundtrip",
        "--input",
        input,
        "--output",
        output,
      ]);
      const result = await outputFile(output, cliReport(step.log, "ir_roundtrip"));
      assert.deepEqual(result.bytes, Buffer.from(bytes));
      bytes = new Uint8Array(result.bytes);
    }
    await writeFile(join(directory, `${packet.message.hash}.bin`), bytes, { flag: "wx" });
    packets.push({ message: packet.message, bytes });
  }
  packets.sort(
    (a, b) => Number(b.message.kind === "media_source") - Number(a.message.kind === "media_source"),
  );
  const input = join(directory, "resources.input.json"),
    output = join(directory, "resources.output.json");
  await writeFile(input, JSON.stringify(packets.map((p) => p.message)), { flag: "wx" });
  const step = await command(`ir-frame-resources-${fixture.id}`, cli, [
    "ir",
    "resources",
    "--input",
    input,
    "--output",
    output,
    "--payloads",
    directory,
  ]);
  const result = await outputFile(output, cliReport(step.log, "ir_resources"));
  const messages = JSON.parse(result.bytes.toString("utf8"));
  assert.deepEqual(
    messages,
    packets.map((p) => p.message),
  );
  const supplied = {
    plan: after,
    resources: messages.map((message, i) => ({ message, bytes: packets[i].bytes })),
  };
  const decoded = runtime.readFrameBundle(supplied);
  assert.deepEqual(await runtime.readFrameBundleAsync(supplied), decoded);
  assert.equal(decoded.mediaPixels.length, decoded.mediaFrames.length);
  assert.deepEqual(decoded, runtime.readFrameBundle(fixture.frameBundle));
  assert.throws(
    () => runtime.readFrameBundle({ ...supplied, resources: supplied.resources.slice(1) }),
    { code: "missing_resource" },
  );
  const corrupt = structuredClone(supplied);
  corrupt.resources.find((p) => p.bytes.length).bytes[0] ^= 1;
  assert.throws(() => runtime.readFrameBundle(corrupt), { code: "hash_mismatch" });
  const rejected = mutate(fixture.bytes, null, (view, start) => view.setUint32(start, 0, true));
  assert.throws(() => runtime.decodeFramePlan(rejected), { code: "invalid_header" });
  const badInput = join(directory, "bad-count.fpln"),
    badOutput = join(directory, "bad-count.out.fpln");
  await writeFile(badInput, rejected, { flag: "wx" });
  const rejection = await command(
    `ir-frame-reject-${fixture.id}`,
    cli,
    ["ir", "roundtrip", "--input", badInput, "--output", badOutput],
    2,
  );
  assert.equal(cliReport(rejection.log).code, "invalid_header");
  await assert.rejects(access(badOutput), { code: "ENOENT" });
  return {
    id: fixture.id,
    capture_admission: await auditBundleCapture(runtime, fixture, packets, directory, options),
    nested_roundtrips: nested,
    resources: messages.length,
    effects: decoded.effects.size,
    generators: decoded.generators.length,
    precompositions: decoded.plans.precompositions.length,
    media_pixels: decoded.mediaPixels.length,
    temporal_passes: decoded.plans.temporal.length,
    exact_payloads: true,
    exact_dependencies: true,
    missing_rejected: true,
    corrupt_rejected: true,
    rust_count_rejected: true,
  };
}
