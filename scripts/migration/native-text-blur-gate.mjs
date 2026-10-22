import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { prepareTextBlurFixtures } from "./native-text-blur-fixtures.mjs";
import { auditBlurPreparation } from "./native-text-blur-preparation.mjs";
import { runNativeTextLayoutGate } from "./native-text-layout-gate.mjs";
import { runNativeTextRoutingGate } from "./native-text-routing-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

export async function runNativeTextBlurGate(context, execute = runStep) {
  const report = {
      status: "failed",
      scope: "evaluated-character-blur-v1",
      native_text_acceptance: false,
      cases: [],
      controls: {},
      blurred: 0,
      clear: 0,
      exposure_blurred: 0,
      center_clear_exposure_blur: 0,
    },
    local = (p) => relative(context.root, p).replaceAll("\\", "/"),
    reader = new M0Evidence(context.root);
  try {
    report.source = await sourceProvenance(context.root);
    const fixture = await prepareTextBlurFixtures({
      ...context,
      output: join(context.output, "fixtures"),
    });
    report.fixture = { path: local(fixture.path), sha256: await hashFile(fixture.path) };
    const manifest = await reader.json(report.fixture.path, report.fixture.sha256),
      observations = join(context.output, "observations"),
      ids = manifest.cases.map((c) => c.id);
    assert.equal(await hashFile(manifest.font.path), manifest.font.sha256);
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
    const ordinary = await reader.json(local(join(observations, "ordinary/report.json"))),
      receipts = await reader.json(local(join(context.output, "routing/native/report.json"))),
      preparation = [],
      expectedPreparation = [];
    assert.equal(receipts.length, manifest.cases.length);
    for (const [index, item] of manifest.cases.entries()) {
      const receipt = receipts[index],
        observed = ordinary.cases[index],
        route = report.routing.cases[index],
        requests = [],
        expected = [];
      assert.equal(receipt.id, item.id);
      assert.equal(observed.id, item.id);
      assert.equal(route.id, item.id);
      assert.equal(receipt.authored_sha256, item.project_sha256);
      assert.equal(receipt.frames.length, observed.observations.length);
      assert.equal(route.native, 0);
      if (!item.temporal) assert.equal(route.exact_pixels, route.records);
      for (const [sample, member] of receipt.frames.entries()) {
        const actual = await reader.json(
            local(join(context.output, "routing/native", member.path)),
            member.sha256,
          ),
          ref = observed.observations[sample],
          captured = await reader.json(
            local(join(observations, "ordinary", item.id, ref.path)),
            ref.sha256,
          );
        assert.deepEqual(captured.sample, observed.samples[sample]);
        for (const result of actual.routes) {
          const decision = result.capability,
            spec = item.layers.find((l) => l.id === decision.request.layer);
          assert(spec);
          assert.equal(result.frame, null);
          assert.equal(decision.project_sha256, receipt.runtime_sha256);
          assert.equal(decision.fonts.length, 1);
          assert.equal(
            Buffer.from(decision.fonts[0].face.sha256).toString("hex"),
            manifest.font.sha256,
          );
          const records = captured.records.filter(
            (r) => r.layer === spec.id && r.instance === result.instance_id,
          );
          assert(records.length > 0);
          const paints = records.map((r) => ({
              record: r,
              draws: r.draws.filter((d) => d.operation === "fillText"),
            })),
            first = paints.find((p) => p.draws.some((d) => d.filter !== "none"));
          report.controls[spec.control] ??= {
            blurred: 0,
            clear: 0,
            nonzero_paint_index: 0,
          };
          const control = report.controls[spec.control];
          if (first) {
            const match =
              /^per-character blur requires native filter composition; paint (\d+) blur ([\d.eE+-]+)px(?:; exposure time ([\d.eE+-]+))?$/u.exec(
                decision.reason,
              );
            assert(match, decision.reason);
            const selected =
              match[3] === undefined
                ? paints[0]
                : paints.find((p) => Math.abs(p.record.local_time - Number(match[3])) < 1e-10);
            assert(selected);
            const draw = selected.draws[Number(match[1])],
              filter = /^blur\(([\d.eE+-]+)px\)$/u.exec(draw?.filter ?? "");
            assert(filter, `Missing observed blur for ${spec.control}`);
            assert(
              Math.abs(Number(filter[1]) - Number(match[2])) <= 0.00001,
              `Blur radius differs: ${filter[1]} / ${match[2]}`,
            );
            assert(Number(match[2]) > 0.00001);
            control.blurred++;
            report.blurred++;
            if (Number(match[1]) > 0) control.nonzero_paint_index++;
            if (match[3] !== undefined) {
              report.exposure_blurred++;
              if (decision.request.source_time === 0 && Number(match[3]) > 0)
                report.center_clear_exposure_blur++;
            }
          } else {
            assert.equal(
              decision.reason,
              spec.control === "disabled-animator"
                ? "requested primary family and CSS family syntax require raster qualification"
                : "per-character paint and affine coverage require pixel qualification",
            );
            control.clear++;
            report.clear++;
          }
          if (!item.temporal) {
            assert.equal(records.length, 1);
            requests.push({ ...decision.request, bounds: null });
            expected.push({ blurred: Boolean(first), font: manifest.font.sha256 });
          }
        }
      }
      if (!item.temporal) {
        preparation.push({
          project: join(context.root, item.project),
          project_sha256: item.project_sha256,
          requests,
        });
        expectedPreparation.push(expected);
      }
      report.cases.push({
        id: item.id,
        frames: receipt.frames.length,
        exact_pixels: route.exact_pixels,
        temporal_samples: route.temporal_samples,
      });
    }
    for (const id of [
      "zero",
      "disabled-group",
      "disabled-animator",
      "unselected",
      "below-threshold",
    ]) {
      assert(report.controls[id].clear > 0);
      assert.equal(report.controls[id].blurred, 0);
    }
    assert(report.controls.nonzero.blurred > 0 && report.controls.nonzero.clear === 0);
    assert(
      report.controls["time-varying"].blurred > 0 && report.controls["time-varying"].clear > 0,
    );
    assert(report.controls["wrapped-selection"].nonzero_paint_index > 0);
    assert(report.exposure_blurred > 0 && report.center_clear_exposure_blur > 0);
    report.preparation = await auditBlurPreparation(
      { ...context, output: join(context.output, "preparation") },
      preparation,
      expectedPreparation,
      reader,
      local,
      execute,
    );
    assert.equal(report.preparation.status, "passed");
    assert.equal(await hashFile(manifest.font.path), manifest.font.sha256);
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
