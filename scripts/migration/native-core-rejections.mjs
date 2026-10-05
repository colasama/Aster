import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "./source.mjs";

/** Missing inputs and unsupported routes must fail before publishing a candidate image. */
export async function runNativeRejections(context, { reader, base, binary }, execute) {
  const results = [];
  const corpus = await reader.json("tests/parity/corpus.json");
  const invoke = async (id, caseId, extra, pattern, existing = false) => {
    const frame = corpus.cases.find((item) => item.id === caseId)?.frames[0];
    assert(Number.isInteger(frame), `Missing rejection case: ${caseId}`);
    const output = existing
      ? join(context.output, "native", "layer-solid", "0.png")
      : join(context.output, "rejected", `${id}.png`);
    const before = existing ? await hashFile(output) : null;
    const step = await execute(
      {
        id: `native-reject-${id}`,
        file: binary,
        args: [
          "render-plan",
          "--plan",
          `${base}/${caseId}/${frame}/replay.fpln`,
          "--resources",
          `${base}/${caseId}/frame-resources`,
          "--out",
          output,
          ...extra,
        ],
        timeout_ms: 120_000,
      },
      context,
    );
    assert.equal(step.exit_code, 2, `Native rejection failed: ${id}`);
    assert.equal(step.status, "failed");
    const error = JSON.parse(
      (await readFile(join(context.root, step.log), "utf8")).trim().split(/\r?\n/).at(-1),
    );
    assert.match(error.error, pattern);
    if (existing) assert.equal(await hashFile(output), before, "Existing output was overwritten");
    else {
      const exists = await stat(output).then(
        () => true,
        (error) => {
          assert.equal(error.code, "ENOENT");
          return false;
        },
      );
      assert.equal(exists, false, "Rejected frame published output");
    }
    results.push({ id, rejected: true, output_unchanged: true, step, error: error.error });
  };
  await invoke("existing-output", "layer-solid", [], /output already exists/, true);
  await invoke("resource-budget", "layer-solid", ["--resource-byte-budget", "16"], /budget/i);
  await invoke("gpu-budget", "layer-solid", ["--gpu-budget-bytes", "16"], /GPU allocation budget/);
  await invoke(
    "image-budget",
    "media-png",
    ["--gpu-budget-bytes", "1170000"],
    /images exceed GPU allocation budget/,
  );
  for (const id of [
    "media-image-sequence",
    "nested-precompositions",
    "scene-masks-mattes-0",
    "scene-particles-billboard",
    "scene-motion-blur",
    "effect-gaussian-blur",
  ]) {
    await invoke(id, id, [], /unsupported native feature/);
  }
  const messages = await reader.json(`${base}/layer-solid/0/resources.json`);
  const corrupted = join(context.output, "corrupt-resources");
  await mkdir(corrupted);
  for (const [index, request] of messages.entries()) {
    const { bytes } = await reader.bytes(`${base}/layer-solid/frame-resources/${request.hash}.bin`);
    if (index === 0) bytes[bytes.length - 1] ^= 1;
    await writeFile(join(corrupted, `${request.hash}.bin`), bytes, { flag: "wx" });
  }
  // Use a separate invocation because clap rejects a duplicated --resources option.
  const output = join(context.output, "rejected", "corrupt.png");
  const step = await execute(
    {
      id: "native-reject-corrupt",
      file: binary,
      args: [
        "render-plan",
        "--plan",
        `${base}/layer-solid/0/replay.fpln`,
        "--resources",
        corrupted,
        "--out",
        output,
      ],
    },
    context,
  );
  assert.equal(step.exit_code, 2);
  const error = JSON.parse(
    (await readFile(join(context.root, step.log), "utf8")).trim().split(/\r?\n/).at(-1),
  );
  assert.match(error.error, /Resource content hash differs/);
  await assert.rejects(stat(output), { code: "ENOENT" });
  results.push({
    id: "corrupt-resource",
    rejected: true,
    output_unchanged: true,
    step,
    error: error.error,
  });
  return results;
}
