import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Qualify default streaming and caller-selected disk budgets against the retained executable. */
export async function validateNativePngBudgets(context, prepared, baseline) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
  const fixture = corpus.cases.find((item) => item.id === "layer-text");
  assert(fixture);
  const request = join(output, "request.json");
  await writeAtomicJson(request, {
    rasterProvider: prepared.rasterProvider,
    plugins: (fixture.plugins ?? []).map((path) => join(root, path, "plugin.toml")),
  });
  const baselineHash = await hashFile(baseline),
    cases = [];
  async function run(name, binary, budget, expectedError) {
    const destination = join(output, name),
      journal = `${destination}.jsonl`;
    const step = await runStep(
      {
        id: name,
        file: binary,
        args: [
          "export",
          "--project",
          join(root, fixture.project),
          "--composition",
          fixture.composition,
          "--request",
          request,
          "--out",
          destination,
          "--format",
          "png-sequence",
          "--image-receipts",
          journal,
          "--start-frame",
          "3",
          "--frames",
          "2",
          "--width",
          "321",
          "--height",
          "181",
          "--ffmpeg",
          join(root, "build/ffmpeg/ffmpeg.exe"),
          "--ffprobe",
          join(root, "build/ffmpeg/ffprobe.exe"),
          "--dxcompiler",
          join(root, "node_modules/electron/dist/dxcompiler.dll"),
          ...(budget === undefined ? [] : ["--image-output-bytes", String(budget)]),
        ],
      },
      context,
    );
    const log = await readFile(join(root, step.log), "utf8");
    if (expectedError) {
      assert.equal(step.exit_code, 2, log);
      assert(log.includes(expectedError), log);
      const files = await readdir(output);
      assert(!files.includes(name));
      assert(!files.includes(`${name}.jsonl`));
      assert(!files.some((path) => path.startsWith(".aster-png-")));
      cases.push({ id: name, status: "passed", expected_rejection: expectedError, step });
      return;
    }
    assert.equal(step.status, "passed", log);
    const rows = log.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const receipt = rows.find((row) => row.status === "passed" && row.image_receipts);
    assert(receipt);
    assert.equal(receipt.report.frames, 2);
    assert.equal(receipt.image_receipts.path, journal);
    const bytes = await readFile(journal);
    assert.equal(bytes.length, receipt.image_receipts.bytes);
    assert.equal(await hashFile(journal), receipt.image_receipts.sha256);
    const images = bytes.toString("utf8").trim().split("\n").map(JSON.parse);
    assert.equal(images.length, 2);
    for (const [index, image] of images.entries()) {
      assert.equal(image.index, index);
      assert.equal(await hashFile(join(destination, image.member)), image.png_sha256);
    }
    cases.push({ id: name, status: "passed", budget, receipt, images, step });
    return images;
  }
  const reference = await run("retained-default", baseline);
  for (const [name, budget] of [
    ["native-default", undefined],
    ["native-large-budget", 21_474_836_480],
  ])
    assert.deepEqual(await run(name, prepared.binary, budget), reference);
  await run("retained-large-budget", baseline, 21_474_836_480, "invalid PNG output bounds");
  await run("native-zero-budget", prepared.binary, 0, "invalid PNG output bounds");
  await run(
    "native-exhausted-budget",
    prepared.binary,
    reference[0].bytes,
    "PNG output byte budget exceeded",
  );
  assert.equal(await hashFile(baseline), baselineHash);
  const report = {
    status: "passed",
    scope:
      "Real two-frame native PNG exports and explicit disk-budget cleanup; large aggregate accounting is covered by Rust tests, not a multi-gigabyte delivery run",
    baseline: { path: baseline, sha256: baselineHash },
    cases,
    self_review: { result: "exact", compared_frames: 4 },
  };
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
