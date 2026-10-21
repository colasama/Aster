import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import electron from "electron";
import { build, preview } from "vite";
import { decodeRgbaPng } from "../parity/png.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { assertTextLayoutPair } from "./native-text-layout-audit.mjs";
import { runNativeTextShapingGate } from "./native-text-shaping-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Bind layout observations to real text draws and prove instrumentation/feature pixel neutrality. */
export async function runNativeTextLayoutGate(context, execute = runStep, options = {}) {
  const started = Date.now();
  const report = {
    status: "failed",
    scope: "production-text-layout-observations-v1",
    cases: [],
    native_text_acceptance: false,
    raw_glyph_identity_available: false,
  };
  let server;
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    report.source = await sourceProvenance(context.root);
    const corpusPath = join(context.root, "tests/parity/corpus.json");
    report.corpus_sha256 = await hashFile(corpusPath);
    const corpus = JSON.parse(await readFile(corpusPath));
    const assignments = [];
    for (const item of corpus.cases) {
      if (options.cases && !options.cases.includes(item.id)) continue;
      let path =
        item.project === "env:ASTER_PERF_PROJECT"
          ? context.env.ASTER_PERF_PROJECT
          : join(context.root, item.project);
      assert(path, "Owner project unavailable");
      if ((await stat(path)).isDirectory()) path = join(path, "project.json");
      const raw = await readFile(path),
        project = JSON.parse(raw);
      if (!project.compositions.some((c) => c.layers.some((l) => l.kind === "text"))) continue;
      const authored = project.compositions.flatMap((c) =>
        c.layers
          .filter((l) => l.kind === "text")
          .map((l) => ({
            composition: c.id,
            layer: l.id,
            visible: l.visible,
            inPoint: l.inPoint,
            outPoint: l.outPoint,
          })),
      );
      const root = project.compositions.find((c) => c.id === item.composition);
      assert(root, "Declared text composition missing");
      const rate = root.frameRate.numerator / root.frameRate.denominator;
      const declared = item.frames.map((frame) => ({
        composition: root.id,
        time: frame / rate,
        scale: Math.max(item.size.width / root.width, item.size.height / root.height),
        scope: "declared-corpus",
      }));
      assignments.push({
        case: item,
        project_path: path,
        project_sha256: sha256(raw),
        authored,
        declared,
        durations: Object.fromEntries(project.compositions.map((c) => [c.id, c.duration])),
      });
    }
    assert(assignments.length > 0, "No text-bearing corpus cases");
    const entry = "tests/parity/native-text-layout/index.html",
      web = join(context.output, "web");
    await build({
      root: context.root,
      configFile: false,
      logLevel: "error",
      build: {
        outDir: web,
        emptyOutDir: false,
        rolldownOptions: { input: [resolve(context.root, entry)] },
      },
    });
    server = await preview({
      root: context.root,
      configFile: false,
      logLevel: "error",
      build: { outDir: web },
      preview: { host: "127.0.0.1", port: 0 },
    });
    const config = join(context.output, "config.json");
    await writeAtomicJson(config, {
      output: context.output,
      assignments,
      url: `http://127.0.0.1:${server.httpServer.address().port}/${entry}`,
    });
    report.electron = { path: local(electron), sha256: await hashFile(electron) };
    for (const mode of ["ordinary", "extended"]) {
      const step = await execute(
        {
          id: `text-layout-${mode}`,
          file: electron,
          args: [
            "scripts/migration/native-text-layout-electron.mjs",
            ...(mode === "extended" ? ["--extended"] : []),
          ],
          timeout_ms: 3_600_000,
          env: { ASTER_TEXT_LAYOUT_CONFIG: config },
        },
        context,
      );
      assert.equal(step.status, "passed", `${mode} layout capture failed: ${step.log}`);
    }
    const ordinary = JSON.parse(await readFile(join(context.output, "ordinary/report.json")));
    const extended = JSON.parse(await readFile(join(context.output, "extended/report.json")));
    assert.equal(ordinary.status, "passed");
    assert.equal(extended.status, "passed");
    const { extended: ignored, ...ordinaryHost } = ordinary.host;
    const { extended: ignoredExtended, ...extendedHost } = extended.host;
    assert.equal(ignored, false);
    assert.equal(ignoredExtended, true);
    assert.deepEqual(ordinaryHost, extendedHost);
    report.host = ordinaryHost;
    assert.equal(ordinary.cases.length, assignments.length);
    assert.equal(extended.cases.length, assignments.length);
    for (const [caseIndex, assignment] of assignments.entries()) {
      const a = ordinary.cases[caseIndex],
        b = extended.cases[caseIndex];
      assert.equal(a.id, assignment.case.id);
      assert.equal(b.id, a.id);
      assert.deepEqual(a.samples, b.samples);
      assert.deepEqual(a.authored, b.authored);
      assert.deepEqual(a.authored, assignment.authored);
      assert.equal(a.project_sha256, assignment.project_sha256);
      assert.equal(b.project_sha256, assignment.project_sha256);
      for (const declared of assignment.declared)
        assert(
          a.samples.some((sample) => JSON.stringify(sample) === JSON.stringify(declared)),
          "Declared text sample missing",
        );
      assert.equal(a.samples.filter((sample) => sample.scope === "random-corpus").length, 64);
      assert.equal(a.project_fonts_sha256, b.project_fonts_sha256);
      assert.equal(a.observations.length, a.samples.length);
      assert.equal(b.observations.length, a.samples.length);
      let records = 0,
        draws = 0;
      const observedLayers = new Set();
      for (const [index, item] of a.observations.entries()) {
        const baselinePath = join(context.output, "ordinary", a.id, item.path),
          candidatePath = join(context.output, "extended", a.id, b.observations[index].path);
        assert.equal(await hashFile(baselinePath), item.sha256);
        assert.equal(await hashFile(candidatePath), b.observations[index].sha256);
        const baseline = JSON.parse(await readFile(baselinePath)),
          candidate = JSON.parse(await readFile(candidatePath));
        assert.deepEqual(baseline.sample, a.samples[index]);
        assertTextLayoutPair(baseline, candidate);
        for (const [recordIndex, record] of candidate.records.entries()) {
          const plain = baseline.records[recordIndex];
          const { image } = record;
          const png = await readFile(join(context.output, "extended", a.id, image.path));
          assert.equal(sha256(png), image.sha256);
          const decoded = decodeRgbaPng(png);
          assert.equal(decoded.width, record.width);
          assert.equal(decoded.height, record.height);
          assert.equal(sha256(decoded.pixels), record.rgba_sha256);
          records += 1;
          draws += plain.draws.length;
          observedLayers.add(`${record.composition}/${record.layer}`);
        }
      }
      assert(records > 0, `No text observations for ${a.id}`);
      const excluded = [];
      for (const layer of assignment.authored) {
        if (observedLayers.has(`${layer.composition}/${layer.layer}`)) continue;
        const reason = !layer.visible
          ? "authored-hidden"
          : layer.outPoint <= 0 ||
              layer.inPoint >= assignment.durations[layer.composition] ||
              layer.outPoint <= layer.inPoint
            ? "outside-composition-time-range"
            : null;
        assert(
          reason,
          `Eligible authored text not observed: ${a.id}/${layer.composition}/${layer.layer}`,
        );
        excluded.push({ ...layer, reason });
      }
      report.cases.push({
        id: a.id,
        project_sha256: assignment.project_sha256,
        project_fonts_sha256: a.project_fonts_sha256,
        samples: a.samples.length,
        records,
        draws,
        observed_layers: [...observedLayers].sort(),
        authored: a.authored,
        excluded_layers: excluded,
        ordinary: {
          path: local(join(context.output, "ordinary/report.json")),
          sha256: await hashFile(join(context.output, "ordinary/report.json")),
        },
        extended: {
          path: local(join(context.output, "extended/report.json")),
          sha256: await hashFile(join(context.output, "extended/report.json")),
        },
      });
      assert.equal(await hashFile(assignment.project_path), assignment.project_sha256);
    }
    let nativeShaping = options.nativeShaping;
    if (nativeShaping === undefined && context.milestone === "M10") {
      const ledger = JSON.parse(
        await readFile(join(context.root, "docs/migration/rust-renderer-progress.json")),
      );
      nativeShaping =
        ledger.milestones.find((m) => m.id === "M10").tasks.find((t) => t.id === "M10-T4")
          ?.status !== "pending";
    }
    if (nativeShaping) {
      report.native_shaping = await runNativeTextShapingGate(
        { ...context, output: join(context.output, "native-shaping") },
        context.output,
        execute,
        options.binary,
      );
      assert.equal(
        report.native_shaping.status,
        "passed",
        "Native text layout component comparison failed",
      );
    }
    report.source_after = await sourceProvenance(context.root);
    assert.equal(report.source_after.source_sha256, report.source.source_sha256);
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    if (server) await new Promise((done) => server.httpServer.close(done));
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
