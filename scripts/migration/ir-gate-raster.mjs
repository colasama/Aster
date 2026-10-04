import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function auditRasterPixels(runtime, { context, cli, command, cliReport, outputFile }) {
  const fixtures = await runtime.rasterPixelFixtures();
  assert.equal(fixtures.length, 3);
  const directory = join(context.output, "raster-payloads");
  await mkdir(directory);
  const messages = fixtures.flatMap((f) => [f.source, f.frame, f.message]);
  for (const fixture of fixtures)
    await writeFile(join(directory, `${fixture.message.hash}.bin`), fixture.bytes);
  const input = join(context.output, "raster-resources.input.json");
  const output = join(context.output, "raster-resources.output.json");
  await writeFile(input, JSON.stringify(messages));
  const step = await command("ir-raster-resources", cli, [
    "ir",
    "resources",
    "--input",
    input,
    "--output",
    output,
    "--payloads",
    directory,
  ]);
  const file = await outputFile(output, cliReport(step.log, "ir_resources"));
  const decoded = JSON.parse(file.bytes.toString("utf8"));
  assert.deepEqual(decoded, messages);
  const registry = new runtime.FrameResourceRegistry({ budget_bytes: 100000, max_resources: 20 });
  for (const message of decoded)
    await registry.apply(
      message,
      message.kind === "raster_pixels"
        ? await readFile(join(directory, `${message.hash}.bin`))
        : undefined,
    );
  for (const fixture of fixtures) {
    const raster = runtime.decodeRasterPixels(
      registry,
      fixture.message.hash,
      fixture.source.descriptor.authorization_scope,
    );
    assert.deepEqual(raster.bytes, fixture.bytes);
    assert.deepEqual(raster.bounds, runtime.readRasterBounds(fixture.frame.descriptor.sample));
    assert.equal(
      await runtime.contentResourceHash(fixture.message, raster.bytes),
      fixture.message.hash,
    );
    assert.throws(() => runtime.decodeRasterPixels(registry, fixture.message.hash, "other-job"), {
      code: "resource_conflict",
    });
    await assert.rejects(registry.apply({ type: "evict_resource", hash: fixture.frame.hash }), {
      code: "resource_in_use",
    });
  }
  for (const message of messages.slice().reverse())
    await registry.apply({ type: "evict_resource", hash: message.hash });
  assert.equal(registry.usedBytes, 0);

  const fixture = fixtures[0];
  const corruptDirectory = join(context.output, "raster-corrupt");
  await mkdir(corruptDirectory);
  const corrupt = fixture.bytes.slice();
  corrupt[0] ^= 1;
  await writeFile(join(corruptDirectory, `${fixture.message.hash}.bin`), corrupt);
  const wrongExtent = structuredClone(fixture.message);
  wrongExtent.descriptor.width *= 2;
  wrongExtent.descriptor.height /= 2;
  wrongExtent.hash = await runtime.contentResourceHash(wrongExtent, fixture.bytes);
  await writeFile(join(directory, `${wrongExtent.hash}.bin`), fixture.bytes);
  const conflicting = {
    ...fixture.message,
    hash: await runtime.contentResourceHash(fixture.message, corrupt),
  };
  await writeFile(join(directory, `${conflicting.hash}.bin`), corrupt);
  for (const message of [fixture.source, fixture.frame]) await registry.apply(message);
  await registry.apply(fixture.message, fixture.bytes);
  const beforeConflict = registry.usedBytes;
  await assert.rejects(registry.apply(conflicting, corrupt), { code: "resource_conflict" });
  assert.equal(registry.usedBytes, beforeConflict);
  for (const [id, values, payloads, code] of [
    ["bytes", [fixture.source, fixture.frame, fixture.message], corruptDirectory, "hash_mismatch"],
    ["frame", [fixture.message], directory, "missing_resource"],
    ["extent", [fixture.source, fixture.frame, wrongExtent], directory, "resource_conflict"],
    [
      "generation",
      [fixture.source, fixture.frame, fixture.message, conflicting],
      directory,
      "resource_conflict",
    ],
    [
      "in-use",
      [
        fixture.source,
        fixture.frame,
        fixture.message,
        { type: "evict_resource", hash: fixture.frame.hash },
      ],
      directory,
      "resource_in_use",
    ],
  ]) {
    const path = join(context.output, `raster-reject-${id}.json`);
    const rejectedOutput = join(context.output, `raster-reject-${id}.output.json`);
    await writeFile(path, JSON.stringify(values));
    const result = await command(
      `ir-raster-reject-${id}`,
      cli,
      ["ir", "resources", "--input", path, "--output", rejectedOutput, "--payloads", payloads],
      2,
    );
    assert.equal(cliReport(result.log).code, code);
    await assert.rejects(access(rejectedOutput), { code: "ENOENT" });
  }
  return {
    status: "passed",
    resources: fixtures.length,
    bytes: fixtures.reduce((n, f) => n + f.bytes.length, 0),
    hashes: fixtures.map((f) => f.message.hash),
    exact_pixels: true,
    exact_bounds: true,
    dependency_eviction: true,
    corrupt_pixels_rejected: true,
    conflicting_generation_rejected: true,
    scope_checked: true,
    output_sha256: file.sha256,
  };
}
