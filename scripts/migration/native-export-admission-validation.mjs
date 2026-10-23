import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Compare delayed source admission with the previous verified native export implementation. */
export async function validateNativeExportAdmission(context, prepared, baseline) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const previous = JSON.parse(await readFile(baseline.validation));
  assert.equal(previous.status, "passed");
  const binaryHash = await hashFile(baseline.binary);
  const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
  const fixture = corpus.cases.find((c) => c.id === "media-png");
  const original = JSON.parse(await readFile(join(root, fixture.project)));
  const report = {
    status: "failed",
    cases: [],
    steps: [],
    baseline: {
      binary: baseline.binary,
      binary_sha256: binaryHash,
      validation: baseline.validation,
      validation_sha256: await hashFile(baseline.validation),
      source_sha256: previous.source_after.source_sha256,
    },
  };
  const run = async (id, binary, project, success = true) => {
    const destination = join(output, id),
      receiptPath = `${destination}.receipts.jsonl`;
    const step = await runStep(
      {
        id,
        file: binary,
        args: [
          "export",
          "--project",
          project,
          "--composition",
          fixture.composition,
          "--out",
          destination,
          "--format",
          "png-sequence",
          "--start-frame",
          "0",
          "--frames",
          "6",
          "--width",
          "320",
          "--height",
          "180",
          "--ffmpeg",
          join(root, "build/ffmpeg/ffmpeg.exe"),
          "--ffprobe",
          join(root, "build/ffmpeg/ffprobe.exe"),
          "--dxcompiler",
          join(root, "node_modules/electron/dist/dxcompiler.dll"),
          ...(success ? [] : ["--image-receipts", receiptPath]),
        ],
      },
      context,
    );
    report.steps.push(step);
    const rows = (await readFile(join(root, step.log), "utf8")).split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    if (!success) {
      assert.equal(step.status, "failed");
      assert(
        rows.some((row) => row.stage === "render" && row.rendered_frames > 0),
        "Failure must occur after initial rendering",
      );
      await assert.rejects(stat(destination));
      await assert.rejects(stat(receiptPath));
      return {
        progress: rows.filter((row) => row.stage),
        output_absent: true,
        journal_absent: true,
      };
    }
    assert.equal(step.status, "passed");
    const receipt = rows.find((row) => row.status === "passed" && row.images);
    assert.equal(receipt?.images.length, 6);
    for (const image of receipt.images)
      assert.equal(await hashFile(join(destination, image.member)), image.png_sha256);
    return receipt.images;
  };
  try {
    for (const late of [true, false]) {
      const document = structuredClone(original),
        composition = document.compositions.find((c) => c.id === fixture.composition);
      const layer = structuredClone(composition.layers[0]),
        source = structuredClone(document.sources[0]);
      const entry = structuredClone(document.mediaImports.entries[0]),
        payload = structuredClone(document.mediaImports.payloads[0]);
      source.id = "delayed-source";
      entry.sourceId = source.id;
      entry.payloadId = "delayed-payload";
      payload.id = entry.payloadId;
      layer.id = "delayed-layer";
      layer.sourceId = source.id;
      layer.inPoint = late
        ? (2 * composition.frameRate.denominator) / composition.frameRate.numerator
        : 1;
      layer.outPoint = 2;
      layer.transform.position[0].value = 200;
      if (!late)
        payload.storage = {
          kind: "relative",
          relativePath: "missing-unused.png",
          byteIdentity: payload.storage.byteIdentity,
        };
      composition.layers.push(layer);
      document.sources.push(source);
      document.mediaImports.entries.push(entry);
      document.mediaImports.payloads.push(payload);
      const name = late ? "delayed-source" : "unused-offline-source",
        project = join(output, `${name}.json`);
      await writeAtomicJson(project, document);
      const before = await run(`${name}-before`, baseline.binary, project);
      const after = await run(`${name}-after`, prepared.binary, project);
      assert.deepEqual(after, before);
      if (late) assert.notEqual(after[0].rgba_sha256, after[2].rgba_sha256);
      report.cases.push({ id: name, status: "passed", exact: true, frames: after });
      if (late) {
        payload.storage = {
          kind: "relative",
          relativePath: "missing-used.png",
          byteIdentity: payload.storage.byteIdentity,
        };
        const invalid = join(output, "failed-late-source.json");
        await writeAtomicJson(invalid, document);
        const evidence = await run("failed-late-source", prepared.binary, invalid, false);
        report.cases.push({
          id: "failed-late-source-leaves-no-output",
          status: "passed",
          ...evidence,
        });
      }
    }
    assert.equal(await hashFile(baseline.binary), binaryHash);
    await prepared.assertUnchanged();
    report.status = "passed";
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
