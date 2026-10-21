import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { prepareNativeProjectRuntime } from "./native-project-runtime.mjs";
import { auditTextRouting } from "./native-text-routing-audit.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Full production partition/M5 audit; temporal union pixel acceptance remains a separate gate. */
export async function runNativeTextRoutingGate(
  context,
  observationRoot,
  execute = runStep,
  options = {},
) {
  const report = {
    status: "failed",
    full_coverage: false,
    native_text_acceptance: false,
    cases: [],
  };
  const reader = new M0Evidence(context.root),
    local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const observation = await reader.json(local(join(observationRoot, "ordinary/report.json")));
    const config = await reader.json(local(join(observationRoot, "config.json")));
    assert.equal(observation.status, "passed");
    const prepared = await prepareNativeProjectRuntime(
      { ...context, output: join(context.output, "runtime") },
      execute,
    );
    report.runtime = {
      source: prepared.source,
      build: prepared.build,
      binaries: prepared.binaries,
      execution: prepared.execution.snapshot,
    };
    const cases = [],
      selected = observation.cases.filter((c) => !options.cases || options.cases.includes(c.id));
    assert(selected.length > 0);
    assert.deepEqual(
      observation.cases.map((c) => c.id),
      config.assignments.map((a) => a.case.id),
    );
    for (const entry of selected) {
      const assignment = config.assignments.find((a) => a.case.id === entry.id);
      assert(assignment);
      assert.equal(await hashFile(assignment.project_path), entry.project_sha256);
      const project = JSON.parse(await readFile(assignment.project_path));
      const samples = entry.samples.slice(0, options.limit ?? entry.samples.length);
      cases.push({
        id: entry.id,
        project: assignment.project_path,
        project_sha256: entry.project_sha256,
        context: {
          visualization: "beauty",
          locale: observation.host.segmentation_locale,
          layouts: {},
          surface: { revision: 1, maxTextureDimension: 4096, memoryBudgetMb: 512, renderScale: 1 },
          maximumRasterDimension: 4096,
          maximumRasterPixels: 67108864,
        },
        frames: samples.map((s) => {
          const c = project.compositions.find((c) => c.id === s.composition);
          assert(c);
          const target = {
            width: Math.round(c.width * s.scale),
            height: Math.round(c.height * s.scale),
          };
          return {
            snapshotScope: `text-routing:${entry.project_sha256}`,
            projectRevision: 1,
            compositionId: s.composition,
            time: s.time,
            target,
            renderTarget: target,
            antiAliasing: "off",
            shadowsEnabled: true,
          };
        }),
      });
    }
    const input = resolve(context.output, "request.json"),
      output = resolve(context.output, "native");
    await writeAtomicJson(input, { provider: prepared.rasterProvider, cases, output });
    report.input = { path: local(input), sha256: await hashFile(input) };
    report.step = await execute(
      {
        id: "native-text-complete-routing",
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
        env: { ASTER_TEXT_ROUTING_INPUT: input },
        timeout_ms: 1800000,
      },
      context,
    );
    assert.equal(report.step.status, "passed");
    const receipts = await reader.json(local(join(output, "report.json")));
    assert.equal(receipts.length, cases.length);
    for (const [index, receipt] of receipts.entries()) {
      const entry = selected[index],
        inputCase = cases[index];
      assert.equal(receipt.id, entry.id);
      assert.equal(receipt.authored_sha256, entry.project_sha256);
      assert.equal(receipt.frames.length, inputCase.frames.length);
      assert.equal(receipt.locale, observation.host.segmentation_locale);
      const audited = {
        id: entry.id,
        frames: [],
        records: 0,
        native: 0,
        retained: 0,
        exact_pixels: 0,
        temporal_samples: 0,
        reasons: {},
      };
      for (const [i, member] of receipt.frames.entries()) {
        const actual = await reader.json(local(join(output, member.path)), member.sha256),
          ref = entry.observations[i];
        const observed = await reader.json(
          local(join(observationRoot, "ordinary", entry.id, ref.path)),
          ref.sha256,
        );
        assert.deepEqual(observed.sample, entry.samples[i]);
        const header = actual.requests.header,
          expected = inputCase.frames[i];
        assert.equal(header.snapshot_scope, expected.snapshotScope);
        assert.equal(header.project_revision, expected.projectRevision);
        assert.equal(header.composition_id, expected.compositionId);
        assert.deepEqual(header.target, expected.target);
        assert.deepEqual(header.render_target, expected.renderTarget);
        assert.equal(header.aa, expected.antiAliasing);
        const time = header.time;
        assert.equal(time.kind, "binary_rational");
        assert.equal(
          time.significand * 2 ** time.exponent * (time.negative ? -1 : 1),
          expected.time,
        );
        assert.deepEqual(actual.retained.header, header);
        const result = auditTextRouting(actual, observed, receipt.runtime_sha256);
        audited.frames.push({
          receipt: { path: local(join(output, member.path)), sha256: member.sha256 },
          ...result,
        });
        for (const key of ["records", "native", "retained", "exact_pixels", "temporal_samples"])
          audited[key] += result[key];
        for (const [reason, count] of Object.entries(result.reasons))
          audited.reasons[reason] = (audited.reasons[reason] ?? 0) + count;
      }
      report.cases.push(audited);
    }
    for (const entry of cases) assert.equal(await hashFile(entry.project), entry.project_sha256);
    await prepared.assertUnchanged();
    report.checked_files = await reader.stable();
    report.full_coverage = !options.cases && !options.limit;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
