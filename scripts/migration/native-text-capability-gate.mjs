import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { prepareTextCapabilityFixtures } from "./native-text-capability-fixtures.mjs";
import { runNativeTextLayoutGate } from "./native-text-layout-gate.mjs";
import { auditTextPaintCapabilities } from "./native-text-paint-audit.mjs";
import { runNativeTextRoutingGate } from "./native-text-routing-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Bind concrete font/script decisions to the authenticated producer and exact retained pixels. */
export async function runNativeTextCapabilityGate(context, execute = runStep) {
  const report = {
      status: "failed",
      scope: "production-font-script-capabilities-v1",
      native_text_acceptance: false,
      cases: [],
    },
    local = (p) => relative(context.root, p).replaceAll("\\", "/"),
    reader = new M0Evidence(context.root);
  try {
    report.source = await sourceProvenance(context.root);
    const fixture = await prepareTextCapabilityFixtures({
      ...context,
      output: join(context.output, "fixtures"),
    });
    report.fixture = { path: local(fixture.path), sha256: await hashFile(fixture.path) };
    const manifest = await reader.json(report.fixture.path, report.fixture.sha256),
      observations = join(context.output, "observations"),
      ids = manifest.cases.map((c) => c.id);
    report.observations = await runNativeTextLayoutGate(
      { ...context, output: observations },
      execute,
      { fixtureManifest: fixture.path, cases: ids, nativeShaping: false, nativeRaster: false },
    );
    assert.equal(report.observations.status, "passed", report.observations.error);
    report.routing = await runNativeTextRoutingGate(
      { ...context, output: join(context.output, "routing") },
      observations,
      execute,
      { cases: ids },
    );
    assert.equal(report.routing.status, "passed", report.routing.error);
    assert.equal(report.routing.cases.length, manifest.cases.length);
    const ordinary = await reader.json(local(join(observations, "ordinary/report.json"))),
      receipts = await reader.json(local(join(context.output, "routing/native/report.json")));
    for (const [index, item] of manifest.cases.entries()) {
      const route = report.routing.cases[index],
        receipt = receipts[index],
        observed = ordinary.cases[index];
      assert.equal(route.id, item.id);
      assert.equal(receipt.id, item.id);
      assert.equal(observed.id, item.id);
      assert.equal(receipt.authored_sha256, item.project_sha256);
      assert.equal(observed.project_fonts_sha256, item.project_fonts_sha256);
      assert.equal(receipt.frames.length, observed.samples.length);
      assert.equal(route.records, receipt.frames.length * item.expected.length);
      assert.equal(route.native, 0);
      assert.equal(route.retained, route.records);
      assert.equal(route.exact_pixels, route.records);
      const reasons = {};
      for (const expected of item.expected)
        reasons[expected.reason] = (reasons[expected.reason] ?? 0) + receipt.frames.length;
      assert.deepEqual(route.reasons, reasons);
      const project = await reader.json(item.project, item.project_sha256);
      for (const member of receipt.frames) {
        const actual = await reader.json(
          local(join(context.output, "routing/native", member.path)),
          member.sha256,
        );
        assert.equal(actual.routes.length, item.expected.length);
        for (const expected of item.expected) {
          const decision = actual.routes.find(
            (r) => r.capability.request.layer === expected.layer,
          )?.capability;
          assert(decision);
          assert.equal(decision.project_sha256, receipt.runtime_sha256);
          assert.equal(decision.reason, expected.reason);
          assert.equal(
            project.compositions
              .find((c) => c.id === item.composition)
              .layers.find((l) => l.id === expected.layer).text,
            expected.text,
          );
          assert.equal(decision.fonts.length, expected.fonts.length);
          for (const [fontIndex, font] of expected.fonts.entries()) {
            assert.equal(decision.fonts[fontIndex].family, font.family);
            assert.equal(
              Buffer.from(decision.fonts[fontIndex].face.sha256).toString("hex"),
              font.sha256,
            );
            assert.equal(decision.fonts[fontIndex].face.index, 0);
            assert.deepEqual(decision.fonts[fontIndex].variations, []);
          }
        }
      }
      report.cases.push({
        id: item.id,
        project_sha256: item.project_sha256,
        frames: receipt.frames.length,
        records: route.records,
        exact_pixels: route.exact_pixels,
        capabilities: item.expected,
      });
    }
    for (const file of Object.values(manifest.sources))
      assert.equal(await hashFile(file.path), file.sha256);
    const cli = report.routing.runtime.binaries.find((b) =>
      b.path.endsWith("aster-render-cli.exe"),
    );
    assert(cli);
    assert.equal(await hashFile(join(context.root, cli.path)), cli.sha256);
    report.paint_controls = await auditTextPaintCapabilities(
      { ...context, output: join(context.output, "paint-controls") },
      manifest,
      join(context.root, cli.path),
      execute,
    );
    assert.equal(report.paint_controls.status, "passed", report.paint_controls.error);
    assert.equal(
      await hashFile(join(context.root, manifest.template.path)),
      manifest.template.sha256,
    );
    assert.equal(
      await hashFile(join(context.root, "tests/parity/corpus.json")),
      manifest.template.corpus_sha256,
    );
    report.checked_files = await reader.stable();
    report.source_after = await sourceProvenance(context.root);
    assert.equal(report.source_after.source_sha256, report.source.source_sha256);
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
