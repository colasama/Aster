import assert from "node:assert/strict";
import { join, relative, resolve } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { prepareTextFontFixtures } from "./native-text-font-fixtures.mjs";
import { runNativeTextLayoutGate } from "./native-text-layout-gate.mjs";
import { runNativeTextRoutingGate } from "./native-text-routing-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Qualify retained embedded containers with equivalent-font and substitution controls. */
export async function runNativeTextFontGate(context, execute = runStep) {
  const report = {
      status: "failed",
      scope: "production-text-font-capabilities-v1",
      native_text_acceptance: false,
      cases: [],
      rejections: [],
    },
    reader = new M0Evidence(context.root),
    local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    report.source = await sourceProvenance(context.root);
    const fixture = await prepareTextFontFixtures({
      ...context,
      output: join(context.output, "fixtures"),
    });
    report.fixture = { path: local(fixture.path), sha256: await hashFile(fixture.path) };
    const manifest = await reader.json(report.fixture.path, report.fixture.sha256),
      valid = manifest.cases.filter((c) => c.format !== "invalid-woff2"),
      observationRoot = join(context.output, "observations");
    report.observations = await runNativeTextLayoutGate(
      { ...context, output: observationRoot },
      execute,
      {
        fixtureManifest: fixture.path,
        cases: valid.map((c) => c.id),
        nativeShaping: false,
        nativeRaster: false,
      },
    );
    assert.equal(report.observations.status, "passed", report.observations.error);
    const ordinary = await reader.json(local(join(observationRoot, "ordinary/report.json")));
    const observations = new Map();
    for (const item of valid) {
      const entry = ordinary.cases.find((c) => c.id === item.id);
      assert(entry);
      assert.equal(entry.project_sha256, item.project_sha256);
      assert.equal(entry.project_fonts_sha256, item.project_fonts_sha256);
      const members = [];
      for (const member of entry.observations)
        members.push(
          await reader.json(
            local(join(observationRoot, "ordinary", item.id, member.path)),
            member.sha256,
          ),
        );
      observations.set(item.format, members);
    }
    const reference = observations.get("ttf"),
      system = observations.get("system");
    assert(reference.length > 0);
    assert.equal(system.length, reference.length);
    const signature = (r) => {
      assert(r.retained_reference && !r.temporal);
      return {
        width: r.width,
        height: r.height,
        bounds: r.bounds,
        rgba_sha256: r.rgba_sha256,
        retained: {
          width: r.retained_reference.width,
          height: r.retained_reference.height,
          bounds: r.retained_reference.bounds,
          gpu_rgba_sha256: r.retained_reference.gpu_rgba_sha256,
        },
      };
    };
    let substitutionDifferences = 0;
    for (const [i, member] of reference.entries()) {
      assert.deepEqual(member.sample, system[i].sample);
      assert.equal(member.records.length, 1);
      assert.equal(system[i].records.length, 1);
      if (
        JSON.stringify(signature(member.records[0])) !==
        JSON.stringify(signature(system[i].records[0]))
      )
        substitutionDifferences++;
    }
    assert(substitutionDifferences > 0, "System substitution control is not observable");
    report.system_substitution_differences = substitutionDifferences;
    const retained = valid.filter((c) => c.expected_reason);
    assert.equal(retained.length, 2);
    report.routing = await runNativeTextRoutingGate(
      { ...context, output: join(context.output, "routing") },
      observationRoot,
      execute,
      { cases: retained.map((c) => c.id) },
    );
    assert.equal(report.routing.status, "passed", report.routing.error);
    assert.equal(report.routing.cases.length, retained.length);
    const native = await reader.json(local(join(context.output, "routing/native/report.json")));
    assert.equal(new Set(native.map((c) => c.runtime_sha256)).size, retained.length);
    for (const item of retained) {
      const observed = observations.get(item.format),
        route = report.routing.cases.find((c) => c.id === item.id);
      assert.equal(observed.length, reference.length);
      assert.equal(route.frames.length, observed.length);
      assert.equal(route.native, 0);
      assert.equal(route.records, observed.length);
      assert.equal(route.retained, route.records);
      assert.equal(route.exact_pixels, route.records);
      assert.deepEqual(route.reasons, { [item.expected_reason]: route.records });
      for (const [i, member] of observed.entries()) {
        assert.deepEqual(member.sample, reference[i].sample);
        assert.equal(member.records.length, 1);
        assert.equal(member.records[0].layer, item.layer);
        assert.deepEqual(
          signature(member.records[0]),
          signature(reference[i].records[0]),
          "Embedded container differs from its original font",
        );
      }
      report.cases.push({
        id: item.id,
        project_sha256: item.project_sha256,
        font_sha256: item.font_sha256,
        font_id: "migration-embedded-face",
        runtime_sha256: native.find((c) => c.id === item.id).runtime_sha256,
        reason: item.expected_reason,
        exact_pixels: route.exact_pixels,
        equivalent_ttf_frames: observed.length,
      });
    }
    const positiveInput = await reader.json(local(join(context.output, "routing/request.json"))),
      malformed = manifest.cases.find((c) => c.format === "invalid-woff2"),
      changed = retained.find((c) => c.format === "woff2"),
      staleSha = valid.find((c) => c.format === "ttf").project_sha256;
    assert.notEqual(changed.project_sha256, staleSha);
    const negativeCases = [
      {
        ...positiveInput.cases[0],
        id: "malformed-font",
        project: resolve(context.root, malformed.project),
        project_sha256: malformed.project_sha256,
        rejection_contains: ["Cannot decode project font: Embedded invalid-woff2"],
      },
      {
        ...positiveInput.cases.find((c) => c.id === changed.id),
        id: "stale-font-revision",
        provider_project_sha256: staleSha,
        rejection_contains: [
          "Expected values to be strictly equal",
          changed.project_sha256,
          staleSha,
        ],
      },
    ];
    const inputPath = join(context.output, "rejection-request.json"),
      output = resolve(context.output, "rejected");
    await writeAtomicJson(inputPath, {
      provider: positiveInput.provider,
      cases: negativeCases,
      output,
    });
    report.rejection_input = { path: local(inputPath), sha256: await hashFile(inputPath) };
    report.rejection_step = await execute(
      {
        id: "embedded-font-rejections",
        file: "cargo",
        args: [
          "test",
          "--release",
          "-p",
          "aster-render-project",
          "--test",
          "text_routing_oracle",
          "--",
          "--ignored",
        ],
        env: { ASTER_TEXT_ROUTING_INPUT: resolve(inputPath) },
        timeout_ms: 180000,
      },
      context,
    );
    assert.equal(report.rejection_step.status, "passed");
    const rejected = await reader.json(local(join(output, "report.json")));
    assert.equal(rejected.length, negativeCases.length);
    for (const [i, receipt] of rejected.entries()) {
      const expected = negativeCases[i];
      assert.equal(receipt.id, expected.id);
      assert.equal(receipt.authored_sha256, expected.project_sha256);
      assert.deepEqual(receipt.frames, []);
      for (const phrase of expected.rejection_contains) assert(receipt.rejection.includes(phrase));
      report.rejections.push(receipt);
    }
    for (const item of manifest.cases)
      assert.equal(await hashFile(join(context.root, item.project)), item.project_sha256);
    assert.equal(await hashFile(manifest.font.path), manifest.font.sha256);
    assert.equal(
      await hashFile(join(context.root, manifest.template.path)),
      manifest.template.sha256,
    );
    assert.equal(
      await hashFile(join(context.root, "tests/parity/corpus.json")),
      manifest.template.corpus_sha256,
    );
    report.source_after = await sourceProvenance(context.root);
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
