import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { editorInteractionModes } from "./preview-editor-interactions.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Independent editor controls and pixels, separate from timed performance runs. */
export async function runEditorInteractionGate(context, execute = runStep) {
  const { root, output } = context;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const pin = async (path) => ({ path: local(path), sha256: await hashFile(path) });
  const report = {
    status: "failed",
    scope: "paired-editor-controls",
    steps: [],
    frames: [],
    arms: [],
  };
  const expected = [
    ...editorInteractionModes,
    "moved",
    "restored",
    "drag-preview",
    "drag-committed",
    "drag-restored",
  ];
  await mkdir(output, { recursive: true });
  try {
    report.source = await sourceProvenance(root);
    report.binary = await pin(join(root, "target/release/aster-render-cli.exe"));
    const arms = [];
    for (const engine of ["ts", "native"]) {
      const directory = join(output, engine);
      const step = await execute(
        {
          id: `editor-${engine}`,
          file: process.execPath,
          args: ["scripts/migration/preview-editor-capture.mjs", directory],
          env: {
            ASTER_PREVIEW_INTERACTIONS: "1",
            ASTER_PREVIEW_ENGINE: engine,
            ASTER_PREVIEW_BENCHMARK_SAMPLES: "0",
            ASTER_PREVIEW_LATENCY_SAMPLES: "0",
          },
          timeout_ms: 300000,
        },
        context,
      );
      report.steps.push(step);
      const path = join(directory, "report.json"),
        witness = JSON.parse(await readFile(path, "utf8"));
      report.arms.push({ engine, report: await pin(path) });
      assert.equal(step.status, "passed", witness.error);
      assert.equal(witness.status, "passed", witness.error);
      assert.equal(witness.engine, engine);
      assert.equal(witness.interactions.status, "passed");
      assert.equal(witness.interactions.restored, true);
      assert.deepEqual(
        witness.interactions.frames.map((frame) => frame.id),
        expected,
      );
      assert.equal(
        await hashFile(witness.interactions.fixture.path),
        witness.interactions.fixture.sha256,
      );
      for (const [index, frame] of witness.interactions.frames.entries()) {
        assert.equal(frame.mode, editorInteractionModes[index] ?? "beauty");
        assert.equal(frame.context.projectId, "9e3585d1-0d5c-47be-ab06-a8240dbbc613");
        assert.equal(frame.context.currentTime, 7 / 30);
        assert.deepEqual(frame.context.selection, ["c4e5bf0c-3a63-4a09-a843-a55bf33b3ede"]);
        assert.equal(frame.path, join(directory, `interaction-${frame.id}.png`));
        assert.equal(await hashFile(frame.path), frame.sha256);
        if (engine === "native")
          assert(
            frame.native_calls.some(
              (call) => call.channel === "aster:native-preview-present" && call.time === 7 / 30,
            ),
            `Native snapshot route missing for ${frame.id}`,
          );
        else assert.equal(frame.native_calls.length, 0);
      }
      arms.push(witness);
    }
    assert.deepEqual(arms[0].interactions.fixture, arms[1].interactions.fixture);
    for (const [index, id] of expected.entries()) {
      const reference = arms[0].interactions.frames[index],
        candidate = arms[1].interactions.frames[index];
      const directory = join(output, "pixels", id),
        contextPath = join(output, `${id}.context.json`);
      await writeAtomicJson(contextPath, {
        case_id: `editor-preview-${id}`,
        isolated: false,
        background: null,
        sequence: null,
      });
      const step = await execute(
        {
          id: `compare-${id}`,
          file: join(root, report.binary.path),
          args: [
            "compare",
            "--reference",
            reference.path,
            "--candidate",
            candidate.path,
            "--tolerance",
            "exact",
            "--context",
            contextPath,
            "--out",
            directory,
          ],
        },
        context,
      );
      const path = join(directory, "report.json"),
        comparison = JSON.parse(await readFile(path, "utf8"));
      report.frames.push({
        id,
        reference: await pin(reference.path),
        candidate: await pin(candidate.path),
        comparison: await pin(path),
        step,
      });
      assert.equal(step.status, "passed");
      assert.equal(comparison.comparison.profile.name, "exact");
      assert.equal(comparison.comparison.passed, true);
      assert.equal(comparison.reference.png_sha256, reference.sha256);
      assert.equal(comparison.candidate.png_sha256, candidate.sha256);
      assert.equal(
        comparison.comparison.reference_rgba_sha256,
        comparison.comparison.candidate_rgba_sha256,
      );
      assert.deepEqual([comparison.comparison.width, comparison.comparison.height], [320, 180]);
    }
    for (const arm of report.arms)
      assert.equal(await hashFile(join(root, arm.report.path)), arm.report.sha256);
    assert.equal(await hashFile(join(root, report.binary.path)), report.binary.sha256);
    report.source_after = await sourceProvenance(root);
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    report.source_unchanged = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
