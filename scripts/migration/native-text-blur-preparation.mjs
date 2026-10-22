import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Exercise the actual native raster entry point, independently of production admission. */
export async function auditBlurPreparation(context, cases, expected, reader, local, execute) {
  const input = resolve(context.output, "requests.json"),
    output = resolve(context.output, "recipes.json");
  await writeAtomicJson(input, cases);
  const report = {
    status: "failed",
    samples: 0,
    blurred: 0,
    clear: 0,
    input: { path: local(input), sha256: await hashFile(input) },
  };
  report.step = await execute(
    {
      id: "native-character-blur-preparation",
      file: "cargo",
      args: [
        "test",
        "--release",
        "-p",
        "aster-render-project",
        "--test",
        "text_preparation_oracle",
        "project_text_preparation_against_canvas",
        "--",
        "--ignored",
      ],
      env: { ASTER_PROJECT_TEXT_INPUT: input, ASTER_PROJECT_TEXT_OUTPUT: output },
    },
    context,
  );
  assert.equal(report.step.status, "passed");
  const receipts = await reader.json(local(output));
  report.output = { path: local(output), sha256: await hashFile(output) };
  assert.equal(receipts.length, cases.length);
  for (const [index, receipt] of receipts.entries()) {
    assert.equal(receipt.project_sha256, cases[index].project_sha256);
    assert(receipt.invalid_request_rejected && receipt.revision_mismatch_rejected);
    assert.equal(receipt.results.length, expected[index].length);
    for (const [sample, result] of receipt.results.entries()) {
      const { blurred, font } = expected[index][sample],
        request = cases[index].requests[sample];
      if (blurred) {
        assert.equal(result.status, "retained");
        assert.deepEqual(result.capability.request, request);
        assert.equal(result.capability.stage, "raster");
        assert.equal(
          result.capability.reason,
          "per-character blur requires native filter composition",
        );
        assert.equal(Buffer.from(result.capability.fonts[0].face.sha256).toString("hex"), font);
        report.blurred++;
      } else {
        assert.equal(result.status, "native");
        assert.deepEqual(result.request, request);
        assert(result.paints.every((p) => p.blur <= 0.00001));
        assert(result.zero_full_layer_cpu_rasters && result.draws > 0);
        assert.equal(Buffer.from(result.fonts[0].face.sha256).toString("hex"), font);
        report.clear++;
      }
      report.samples++;
    }
  }
  assert(report.blurred > 0 && report.clear > 0);
  assert.equal(await hashFile(input), report.input.sha256);
  report.status = "passed";
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
