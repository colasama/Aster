import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function auditTexturePixels(
  runtime,
  { context, cli, command, cliReport, outputFile },
) {
  const fixtures = runtime.texturePixelFixtures();
  assert.equal(fixtures.length, 5);
  const payloads = join(context.output, "texture-payloads");
  await mkdir(payloads);
  const messages = fixtures.map((f) => f.message);
  for (const f of fixtures) await writeFile(join(payloads, `${f.message.hash}.bin`), f.bytes);
  const input = join(context.output, "textures.input.json");
  const output = join(context.output, "textures.output.json");
  await writeFile(input, JSON.stringify(messages));
  const step = await command("ir-texture-resources", cli, [
    "ir",
    "resources",
    "--input",
    input,
    "--output",
    output,
    "--payloads",
    payloads,
  ]);
  const file = await outputFile(output, cliReport(step.log, "ir_resources"));
  const decoded = JSON.parse(file.bytes.toString("utf8"));
  assert.deepEqual(decoded, messages);
  const registry = new runtime.FrameResourceRegistry({ budget_bytes: 10000, max_resources: 10 });
  const previousUsage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2 };
  try {
    for (let index = 0; index < decoded.length; index++) {
      const message = decoded[index];
      const bytes = await readFile(join(payloads, `${message.hash}.bin`));
      await registry.apply(message, bytes);
      const resource = registry.resolve(message.hash);
      assert.deepEqual(resource.bytes, fixtures[index].bytes);
      const uploads = [];
      const allocations = [];
      runtime.uploadTexturePixels(
        {
          limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 256 },
          createTexture: (descriptor) => {
            allocations.push(descriptor);
            return {};
          },
          queue: {
            writeTexture: (_destination, bytes, layout, extent) =>
              uploads.push({ bytes, layout, extent }),
          },
        },
        message,
        resource.bytes,
        "Decoded texture upload",
      );
      const d = message.descriptor;
      assert.equal(allocations[0].format, d.format);
      assert.equal(allocations[0].dimension, d.dimension);
      assert.deepEqual(uploads[0].bytes, fixtures[index].bytes);
      assert.deepEqual(uploads[0].layout, {
        bytesPerRow: d.width * (d.format === "rgba16float" ? 8 : 4),
        rowsPerImage: d.height,
      });
      assert.deepEqual(uploads[0].extent, {
        width: d.width,
        height: d.height,
        depthOrArrayLayers: d.depth,
      });
    }
  } finally {
    if (previousUsage === undefined) delete globalThis.GPUTextureUsage;
    else globalThis.GPUTextureUsage = previousUsage;
  }
  const corrupt = new Uint8Array(fixtures[0].bytes);
  corrupt[0] ^= 1;
  await assert.rejects(registry.apply(fixtures[0].message, corrupt), { code: "hash_mismatch" });
  const broken = join(context.output, "texture-corrupt");
  await mkdir(broken);
  await writeFile(join(broken, `${fixtures[0].message.hash}.bin`), corrupt);
  const badInput = join(context.output, "texture-reject.json");
  await writeFile(badInput, JSON.stringify([fixtures[0].message]));
  const badOutput = join(context.output, "texture-rejected.output.json");
  const failure = await command(
    "ir-texture-reject-bytes",
    cli,
    ["ir", "resources", "--input", badInput, "--output", badOutput, "--payloads", broken],
    2,
  );
  assert.equal(cliReport(failure.log).code, "hash_mismatch");
  await assert.rejects(access(badOutput), { code: "ENOENT" });
  return {
    status: "passed",
    resources: fixtures.length,
    bytes: fixtures.reduce((sum, f) => sum + f.bytes.length, 0),
    exact_pixels: true,
    supplied_upload: true,
    corrupt_pixels_rejected: true,
  };
}
