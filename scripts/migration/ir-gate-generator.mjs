import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function auditGeneratorResources(
  fixtures,
  { context, cli, command, cliReport, outputFile },
) {
  const shaders = new Map(
    fixtures.flatMap((f) => f.generator.program.shaders.map((r) => [r.message.hash, r])),
  );
  const payloads = join(context.output, "generator-shaders");
  await mkdir(payloads);
  const records = [...shaders.values()].sort((a, b) =>
    a.message.hash.localeCompare(b.message.hash),
  );
  for (const r of records) await writeFile(join(payloads, `${r.message.hash}.bin`), r.bytes);
  const input = join(context.output, "generator-shaders.input.json"),
    output = join(context.output, "generator-shaders.output.json");
  await writeFile(input, JSON.stringify(records.map((r) => r.message)));
  const step = await command("ir-generator-shaders", cli, [
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
  assert.deepEqual(
    decoded,
    records.map((r) => r.message),
  );
  const resources = new Map();
  for (const message of decoded)
    resources.set(message.hash, {
      message,
      bytes: new Uint8Array(await readFile(join(payloads, `${message.hash}.bin`))),
    });
  return resources;
}
