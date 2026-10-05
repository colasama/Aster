import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mutate } from "./ir-gate-precomposition.mjs";

export async function auditPrecompositionBundle(runtime, fixture, after, options) {
  const { context, cli, command, cliReport, outputFile } = options;
  const directory = join(context.output, fixture.id);
  await mkdir(directory);
  const packets = [];
  let nested = 0;
  for (const resource of fixture.bundle.resources) {
    let bytes = resource.bytes;
    if (
      resource.message.kind === "buffer" &&
      Buffer.from(bytes.subarray(0, 4)).toString() === "FPLN"
    ) {
      const input = join(directory, `${resource.message.hash}.input.fpln`);
      const output = join(directory, `${resource.message.hash}.output.fpln`);
      await writeFile(input, bytes, { flag: "wx" });
      const step = await command(`ir-roundtrip-bundle-${fixture.id}-${nested++}`, cli, [
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
    await writeFile(join(directory, `${resource.message.hash}.bin`), bytes, { flag: "wx" });
    packets.push({ message: resource.message, bytes });
  }
  // Sources precede dependent frames at the resource registry boundary.
  packets.sort(
    (a, b) => Number(b.message.kind === "media_source") - Number(a.message.kind === "media_source"),
  );
  const input = join(directory, "resources.input.json"),
    output = join(directory, "resources.output.json");
  await writeFile(input, JSON.stringify(packets.map((r) => r.message)), { flag: "wx" });
  const step = await command(`ir-bundle-resources-${fixture.id}`, cli, [
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
    packets.map((r) => r.message),
  );
  const supplied = messages.map((message, index) => ({ message, bytes: packets[index].bytes }));
  const decoded = runtime.readPrecompositionBundle(after, supplied);
  assert.deepEqual(decoded.plans, fixture.plans);
  assert.throws(() => runtime.readPrecompositionBundle(after, supplied.slice(1)), {
    code: "missing_resource",
  });
  const corrupt = supplied.map((r) => ({ message: r.message, bytes: new Uint8Array(r.bytes) }));
  corrupt.find((r) => r.bytes.length).bytes[0] ^= 1;
  assert.throws(() => runtime.readPrecompositionBundle(after, corrupt), { code: "hash_mismatch" });
  const rejected = mutate(fixture.bytes, null, (view, start) => view.setUint32(start, 11, true));
  assert.throws(() => runtime.decodeFramePlan(rejected), { code: "invalid_precomposition" });
  const invalidInput = join(directory, "invalid-count.fpln"),
    invalidOutput = join(directory, "invalid-count.output.fpln");
  await writeFile(invalidInput, rejected, { flag: "wx" });
  const rejection = await command(
    `ir-precomposition-reject-bundle-${fixture.id}`,
    cli,
    ["ir", "roundtrip", "--input", invalidInput, "--output", invalidOutput],
    2,
  );
  assert.equal(cliReport(rejection.log).code, "invalid_precomposition");
  await assert.rejects(access(invalidOutput), { code: "ENOENT" });
  return {
    id: fixture.id,
    scenes: decoded.plans.length,
    resources: supplied.length,
    nested_roundtrips: nested,
    exact_payloads: true,
    exact_dependencies: true,
    missing_rejected: true,
    corrupt_rejected: true,
    rust_count_rejected: true,
  };
}
