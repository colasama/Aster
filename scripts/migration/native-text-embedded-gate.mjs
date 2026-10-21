import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runNativeProjectTextGate } from "./native-project-text-gate.mjs";
import { prepareEmbeddedTextFixture } from "./native-text-embedded-fixture.mjs";
import { runNativeTextLayoutGate } from "./native-text-layout-gate.mjs";
import { runNativeTextRoutingGate } from "./native-text-routing-gate.mjs";
import { runNativeTextSessionGate } from "./native-text-session-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Admit embedded outlines only with actual project shaping, GPU pixels and independent replay. */
export async function runNativeEmbeddedTextGate(context, execute = runStep) {
  const report = {
    status: "failed",
    scope: "native-embedded-outline-v1",
    native_text_acceptance: false,
  };
  const local = (p) => relative(context.root, p).replaceAll("\\", "/"),
    reader = new M0Evidence(context.root);
  try {
    report.source = await sourceProvenance(context.root);
    const fixture = await prepareEmbeddedTextFixture({
      ...context,
      output: join(context.output, "fixtures"),
    });
    report.fixture = { path: local(fixture.path), sha256: await hashFile(fixture.path) };
    const manifest = await reader.json(report.fixture.path, report.fixture.sha256),
      observations = join(context.output, "observations");
    assert.equal(await hashFile(manifest.font.path), manifest.font.sha256);
    report.observations = await runNativeTextLayoutGate(
      { ...context, output: observations },
      execute,
      {
        fixtureManifest: fixture.path,
        cases: manifest.cases.map((c) => c.id),
        nativeShaping: false,
        nativeRaster: false,
      },
    );
    assert.equal(report.observations.status, "passed", report.observations.error);
    assert.equal(await hashFile(manifest.unqualified_font.path), manifest.unqualified_font.sha256);
    report.unqualified = await runNativeTextRoutingGate(
      { ...context, output: join(context.output, "unqualified") },
      observations,
      execute,
      { cases: ["embedded-unqualified-control"] },
    );
    assert.equal(report.unqualified.status, "passed", report.unqualified.error);
    const rejected = report.unqualified.cases[0];
    assert.equal(report.unqualified.cases.length, 1);
    assert.equal(rejected.native, 0);
    assert.equal(rejected.retained, 70);
    assert.equal(rejected.exact_pixels, 70);
    assert.deepEqual(rejected.reasons, {
      "embedded font embedded-unqualified-control physical face requires raster qualification": 70,
    });
    const rejectedReceipts = await reader.json(
      local(join(context.output, "unqualified/native/report.json")),
    );
    assert.equal(rejectedReceipts.length, 1);
    for (const member of rejectedReceipts[0].frames) {
      const receipt = await reader.json(
        local(join(context.output, "unqualified/native", member.path)),
        member.sha256,
      );
      assert.equal(receipt.routes.length, 1);
      const fonts = receipt.routes[0].capability.fonts;
      assert.equal(fonts.length, 1);
      assert.equal(fonts[0].family, "Arial");
      assert.equal(
        Buffer.from(fonts[0].face.sha256).toString("hex"),
        manifest.unqualified_font.sha256,
      );
    }
    const preparation = join(context.output, "preparation");
    report.preparation = await runNativeProjectTextGate(
      { ...context, output: preparation },
      observations,
      execute,
      { fixtureManifest: fixture.path, cases: ["embedded-native-outline"] },
    );
    assert.equal(report.preparation.status, "passed", report.preparation.error);
    const recipes = await reader.json(
      local(join(preparation, "recipes.json")),
      report.preparation.output.sha256,
    );
    assert.equal(recipes.length, 1);
    for (const result of recipes[0].results) {
      assert.equal(result.status, "native");
      assert.equal(result.fonts.length, 1);
      const font = result.fonts[0];
      assert.equal(font.family, "Arial");
      assert.equal(font.weight, 700);
      assert.equal(Buffer.from(font.face.sha256).toString("hex"), manifest.font.sha256);
      assert.equal(font.face.index, 0);
      assert.deepEqual(font.variations, []);
    }
    report.session = await runNativeTextSessionGate(
      { ...context, output: join(context.output, "session") },
      observations,
      execute,
      { fixtureManifest: fixture.path },
    );
    assert.equal(report.session.status, "passed", report.session.error);
    assert.equal(report.session.native_text_acceptance, true);
    assert.equal(report.session.samples.length, recipes[0].results.length);
    assert.equal(report.session.samples.length, report.session.equivalence.exact_samples);
    assert.equal(await hashFile(manifest.font.path), manifest.font.sha256);
    assert.equal(await hashFile(manifest.unqualified_font.path), manifest.unqualified_font.sha256);
    assert.equal(
      await hashFile(join(context.root, manifest.template.project)),
      manifest.template.project_sha256,
    );
    report.checked_files = await reader.stable();
    report.source_after = await sourceProvenance(context.root);
    assert.equal(report.source_after.source_sha256, report.source.source_sha256);
    report.native_text_acceptance = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
