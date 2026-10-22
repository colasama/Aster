import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import electron from "electron";
import { build } from "vite";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { captureAssignments } from "../parity/provenance.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Frozen references supply addresses only; native project evaluation feeds the production canvas. */
export async function runPreviewCorpus(context, execute = runStep, selectedCases) {
  const { root, output } = context;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = {
    status: "failed",
    full_coverage: false,
    native_preview_acceptance: false,
    cases: [],
  };
  const started = Date.now();
  await mkdir(output, { recursive: true });
  try {
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const inputs = new PixelInputs(context);
    await inputs.loadReferenceCatalog();
    const cases = selectedCases
      ? inputs.corpus.cases.filter((item) => selectedCases.includes(item.id))
      : inputs.corpus.cases;
    assert(cases.length > 0);
    if (selectedCases) assert.equal(cases.length, new Set(selectedCases).size);
    const assignments = await captureAssignments(root, cases, context.env);
    const binary = join(root, "target/release/aster-render-cli.exe");
    const bridge = join(root, "target/release/aster-desktop-bridge.exe");
    report.binaries = await Promise.all(
      [binary, bridge].map(async (path) => ({ path: local(path), sha256: await hashFile(path) })),
    );
    const jobs = [];
    for (const assignment of assignments) {
      assert(!assignment.unavailable, assignment.unavailable);
      const item = assignment.case;
      const project = (await stat(assignment.projectPath)).isDirectory()
        ? join(assignment.projectPath, "project.json")
        : assignment.projectPath;
      const samples = [];
      for (const frame of item.frames) {
        const reference = await inputs.baseReference(item, frame);
        assert.deepEqual(reference.capture.inputs, assignment.inputs);
        await inputs.projectComposition(item, reference.capture);
        samples.push({ frame, time: reference.meta.time });
      }
      const scale = item.aa === "ssaa4x" ? 4 : item.aa === "ssaa2x" ? 2 : 1;
      const scope = `native-preview-corpus:${item.id}`;
      const request = join(output, "requests", `${item.id}.json`);
      await writeAtomicJson(request, {
        frame: {
          snapshotScope: scope,
          projectRevision: 0,
          compositionId: item.composition,
          time: samples[0].time,
          target: item.size,
          renderTarget: { width: item.size.width * scale, height: item.size.height * scale },
          antiAliasing: item.aa,
          shadowsEnabled: true,
        },
        settings: {
          resources: {
            visualization: "beauty",
            locale: "en-US",
            layouts: {},
            surface: {
              revision: 1,
              maxTextureDimension: 4096,
              memoryBudgetMb: 512,
              renderScale: scale,
            },
            maximumRasterDimension: 8192,
            maximumRasterPixels: 67108864,
          },
          selectedLayerId: null,
          shadowMapSize: 1024,
        },
        plugins: (item.plugins ?? []).map((path) => join(root, path, "plugin.toml")),
        rasterProvider: {
          executable: electron,
          arguments: [join(root, "dist-electron/electron/native-raster-host.js")],
          bundle: join(root, "dist/native-raster/native-raster.html"),
          bridge,
          timeoutMs: 120000,
          cacheBytes: 67108864,
        },
      });
      jobs.push({
        id: item.id,
        composition: item.composition,
        size: item.size,
        scope,
        project,
        project_sha256: assignment.inputs.project_sha256,
        request,
        samples,
      });
      report.cases.push({
        id: item.id,
        frames: item.frames,
        project_sha256: assignment.inputs.project_sha256,
        request: { path: local(request), sha256: await hashFile(request) },
      });
    }
    await build({
      root,
      base: "./",
      configFile: false,
      logLevel: "error",
      build: {
        outDir: join(output, "web"),
        emptyOutDir: false,
        rollupOptions: { input: join(root, "tests/parity/native-preview-corpus.html") },
      },
    });
    const destination = join(output, "capture");
    await mkdir(destination);
    const config = join(output, "config.json");
    await writeAtomicJson(config, {
      root,
      output: destination,
      binary,
      compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
      html: join(output, "web/tests/parity/native-preview-corpus.html"),
      jobs,
    });
    report.configuration = { path: local(config), sha256: await hashFile(config) };
    report.step = await execute(
      {
        id: "preview-corpus-capture",
        file: electron,
        args: ["scripts/migration/preview-corpus-electron.mjs"],
        env: { ASTER_PREVIEW_CORPUS_CONFIG: config },
        timeout_ms: 3700000,
      },
      context,
    );
    const path = join(destination, "report.json");
    const witness = await inputs.json(path);
    report.capture = { path: local(path), sha256: await hashFile(path) };
    assert.equal(report.step.status, "passed", witness.error);
    assert.equal(witness.status, "passed", witness.error);
    assert.equal(witness.all_references_released, true);
    assert.deepEqual(
      witness.cases.map((item) => item.id),
      cases.map((item) => item.id),
    );
    const expected = jobs.flatMap((job) =>
      job.samples.map((sample) => ({ case_id: job.id, ...sample })),
    );
    assert.deepEqual(
      witness.frames.map(({ case_id, frame, time }) => ({ case_id, frame, time })),
      expected,
    );
    const manifest = join(destination, "candidates.json");
    await writeAtomicJson(manifest, {
      schema_version: 1,
      kind: "native-project-preview-candidate",
      frames: witness.frames,
    });
    report.candidates = { path: local(manifest), sha256: await hashFile(manifest) };
    report.pixels = await runPixelGate(
      { ...context, output: join(output, "pixels") },
      {
        manifestPath: manifest,
        scope: selectedCases ? "diagnostic" : "full",
        profileOverride: null,
      },
      execute,
    );
    await inputs.verifyStable();
    assert.deepEqual(await captureAssignments(root, cases, context.env), assignments);
    for (const item of [report.configuration, ...report.cases.map((item) => item.request)])
      assert.equal(await hashFile(join(root, item.path)), item.sha256);
    for (const item of report.binaries)
      assert.equal(await hashFile(join(root, item.path)), item.sha256);
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source_after.source_sha256 === report.source.source_sha256;
    assert(report.source_unchanged);
    assert.equal(
      report.pixels.status,
      "passed",
      "Native preview pixel comparisons or self-reviews remain open",
    );
    report.full_coverage = !selectedCases;
    report.native_preview_acceptance = !selectedCases;
    report.status = "passed";
  } catch (error) {
    report.error = String(error.stack ?? error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
