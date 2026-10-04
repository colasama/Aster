import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Cross-language descriptor identities are verified by actual Rust registry admission. */
export async function auditMediaResources(
  runtime,
  { context, cli, command, cliReport, outputFile },
) {
  const messages = await runtime.mediaResourceFixtures();
  const registry = new runtime.FrameResourceRegistry({ budget_bytes: 10000, max_resources: 20 });
  for (const message of messages) await registry.apply(message);
  const before = registry.usedBytes;
  for (const message of messages) {
    assert.deepEqual(registry.resolve(message.hash).content.descriptor, message.descriptor);
    assert.equal(await runtime.contentResourceHash(message), message.hash);
    assert.equal(runtime.contentResourceHashSync(message), message.hash);
    if (message.kind === "media_frame" && message.descriptor.sample.kind === "raster") {
      const bounds = runtime.readRasterBounds(message.descriptor.sample);
      assert(Object.is(bounds.x, -0));
      assert.deepEqual(bounds, { x: -0, y: -12.25, width: Math.PI, height: 45.5 });
    }
  }
  const transcript = [
    ...messages,
    ...messages
      .slice()
      .reverse()
      .map(({ hash }) => ({ type: "evict_resource", hash })),
  ];
  for (const message of transcript.slice(messages.length)) await registry.apply(message);
  assert.equal(registry.usedBytes, 0);
  const input = join(context.output, "media-resources.input.json");
  const output = join(context.output, "media-resources.output.json");
  await writeFile(input, JSON.stringify(transcript));
  const step = await command("ir-media-resources", cli, [
    "ir",
    "resources",
    "--input",
    input,
    "--output",
    output,
  ]);
  const file = await outputFile(output, cliReport(step.log, "ir_resources"));
  const decoded = JSON.parse(file.bytes.toString("utf8"));
  assert.deepEqual(decoded, transcript);
  for (const message of decoded) {
    runtime.validateResourceMessage(message);
    if (message.type === "put_resource")
      assert.equal(await runtime.contentResourceHash(message), message.hash);
  }
  const wrongHash = structuredClone(messages);
  wrongHash[0].hash = "0".repeat(64);
  const wrongKind = structuredClone(messages);
  wrongKind[0].kind = "media_frame";
  const earlyEviction = [
    messages[0],
    messages[1],
    { type: "evict_resource", hash: messages[0].hash },
  ];
  const raster = structuredClone(
    messages.find((m) => m.kind === "media_frame" && m.descriptor.sample.kind === "raster"),
  );
  assert(raster);
  raster.descriptor.sample.bounds_f64_le[0] = 0;
  raster.descriptor.sample.bounds_f64_le[1] = 0x7ff00000;
  const badBounds = [messages.find((m) => m.hash === raster.descriptor.source), raster];
  for (const [id, values, code] of [
    ["hash", wrongHash, "hash_mismatch"],
    ["kind", wrongKind, "invalid_resource"],
    ["missing", [messages[1]], "missing_resource"],
    ["in-use", earlyEviction, "resource_in_use"],
    ["bounds", badBounds, "invalid_resource"],
  ]) {
    const path = join(context.output, `media-reject-${id}.json`);
    await writeFile(path, JSON.stringify(values));
    const rejected = await command(
      `ir-media-reject-${id}`,
      cli,
      [
        "ir",
        "resources",
        "--input",
        path,
        "--output",
        join(context.output, `media-reject-${id}.output.json`),
      ],
      2,
    );
    assert.equal(cliReport(rejected.log).code, code);
    await assert.rejects(access(join(context.output, `media-reject-${id}.output.json`)), {
      code: "ENOENT",
    });
  }
  return {
    status: "passed",
    roundtrips: messages.length,
    hashes: messages.map((m) => m.hash),
    descriptor_bytes: before,
    dependency_eviction: true,
    exact_video_times: true,
    exact_raster_bounds: true,
    source_kinds: ["image", "sequence", "video", "raster"],
    output_sha256: file.sha256,
  };
}
