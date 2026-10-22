import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pluginLifecycleStates } from "./preview-editor-plugins.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Paired editor plugin lifecycle with exact pixels and authenticated native presentation. */
export async function runEditorPluginGate(context, execute = runStep) {
  const { root, output } = context;
  const pin = async (path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: await hashFile(path),
  });
  const report = {
    status: "failed",
    scope: "paired-editor-installed-plugins",
    steps: [],
    arms: [],
    frames: [],
  };
  await mkdir(output, { recursive: true });
  try {
    report.source = await sourceProvenance(root);
    // The development editor prefers the debug bridge even when the renderer is a release build.
    const bridgeBuild = await execute(
      { id: "editor-plugin-bridge", file: "cargo", args: ["build", "-p", "aster-desktop-bridge"] },
      context,
    );
    report.steps.push(bridgeBuild);
    assert.equal(bridgeBuild.status, "passed");
    report.bridge = await pin(join(root, "target/debug/aster-desktop-bridge.exe"));
    report.binary = await pin(join(root, "target/release/aster-render-cli.exe"));
    const witnesses = [];
    const expected = pluginLifecycleStates.flatMap((state, index) =>
      (index % 2 === 0 ? ["root", "nested"] : ["nested", "root"]).map(
        (layout) => `${state}-${layout}`,
      ),
    );
    for (const engine of ["ts", "native"]) {
      const directory = join(output, engine);
      const step = await execute(
        {
          id: `plugins-${engine}`,
          file: process.execPath,
          args: ["scripts/migration/preview-editor-capture.mjs", directory],
          env: {
            ASTER_PREVIEW_PLUGINS: "1",
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
      assert.equal(witness.plugins.status, "passed");
      assert.deepEqual(
        witness.plugins.frames.map((frame) => frame.id),
        expected,
      );
      assert.deepEqual(
        witness.plugins.transitions.map((item) => item.state),
        pluginLifecycleStates.slice(1),
      );
      for (const fixture of witness.plugins.fixtures)
        assert.equal(await hashFile(fixture.path), fixture.sha256);
      for (const frame of witness.plugins.frames) {
        assert.equal(frame.path, join(directory, `${frame.id}.png`));
        assert.equal(await hashFile(frame.path), frame.sha256);
        assert.equal(frame.context.currentTime, 0);
        assert.equal(
          frame.context.projectId,
          witness.plugins.fixtures.find((f) => f.layout === frame.layout).projectId,
        );
        if (engine === "native")
          assert(
            frame.native_calls.some(
              (c) => c.channel === "aster:native-preview-present" && c.time === 0,
            ),
            `Missing native route for ${frame.id}`,
          );
        else assert.equal(frame.native_calls.length, 0);
      }
      for (const state of pluginLifecycleStates.slice(1))
        assert(
          witness.plugins.frames.some((frame) => frame.state === state && frame.live_transition),
        );
      witnesses.push(witness);
    }
    assert.deepEqual(
      witnesses[0].plugins.fixtures.map((f) => f.sha256),
      witnesses[1].plugins.fixtures.map((f) => f.sha256),
    );
    for (const [index, id] of expected.entries()) {
      const reference = witnesses[0].plugins.frames[index],
        candidate = witnesses[1].plugins.frames[index];
      const directory = join(output, "pixels", id),
        contextPath = join(output, `${id}.context.json`);
      await writeAtomicJson(contextPath, {
        case_id: `editor-plugin-${id}`,
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
    assert.equal(await hashFile(join(root, report.bridge.path)), report.bridge.sha256);
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
