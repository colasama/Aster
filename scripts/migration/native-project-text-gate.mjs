import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { auditNativeShape } from "./native-text-shaping-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Authored project -> native recipes, compared with actual Canvas calls. Pixel acceptance remains separate. */
export async function runNativeProjectTextGate(
  context,
  observationRoot,
  execute = runStep,
  options = {},
) {
  const report = {
    status: "failed",
    native_text_acceptance: false,
    cases: [],
    comparisons: [],
    maxima: { advance: 0, baseline: 0, transform: 0, cluster_advance: 0, cluster_position: 0 },
  };
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    const mode = options.fixtureManifest ? "extended" : "ordinary";
    const observationPath = join(observationRoot, mode, "report.json");
    const observations = JSON.parse(await readFile(observationPath));
    assert.equal(observations.status, "passed");
    const corpus = JSON.parse(
      await readFile(options.fixtureManifest ?? join(context.root, "tests/parity/corpus.json")),
    );
    if (options.fixtureManifest) assert(options.cases?.length > 0);
    const selected = options.cases ?? ["layer-text", "scene-motion-blur", "scene-text-animators"];
    const cases = [],
      expected = [];
    for (const id of selected) {
      const source = observations.cases.find((c) => c.id === id),
        assignment = corpus.cases.find((c) => c.id === id);
      assert(source && assignment, `Missing authored text preparation case ${id}`);
      let project = join(context.root, assignment.project);
      if ((await stat(project)).isDirectory()) project = join(project, "project.json");
      assert.equal(await hashFile(project), source.project_sha256);
      const requests = [],
        records = [];
      for (const item of source.observations) {
        const path = join(observationRoot, mode, id, item.path);
        assert.equal(await hashFile(path), item.sha256);
        const observed = JSON.parse(await readFile(path));
        for (const record of observed.records) {
          assert.equal(record.observation_neutral, true);
          requests.push({
            composition: record.composition,
            layer: record.layer,
            source_time: record.local_time,
            resolution_scale: record.requested_scale,
            maximum_dimension: 4096,
            locale: observations.host.segmentation_locale,
            bounds: null,
          });
          records.push(record);
        }
      }
      assert(requests.length > 0 && requests.length <= 4096);
      cases.push({ project, project_sha256: source.project_sha256, requests });
      expected.push(records);
      report.cases.push({ id, project_sha256: source.project_sha256, requests: requests.length });
    }
    const input = resolve(context.output, "requests.json"),
      output = resolve(context.output, "recipes.json");
    await writeAtomicJson(input, cases);
    report.observations = { path: local(observationPath), sha256: await hashFile(observationPath) };
    report.input = { path: local(input), sha256: await hashFile(input) };
    report.step = await execute(
      {
        id: "native-project-text-preparation",
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
    const receipts = JSON.parse(await readFile(output));
    report.output = { path: local(output), sha256: await hashFile(output) };
    assert.equal(receipts.length, cases.length);
    for (const [index, receipt] of receipts.entries()) {
      assert.equal(receipt.project_sha256, cases[index].project_sha256);
      assert.equal(receipt.invalid_request_rejected, true);
      assert.equal(receipt.revision_mismatch_rejected, true);
      assert.equal(receipt.results.length, expected[index].length);
      for (const [sample, result] of receipt.results.entries()) {
        const record = expected[index][sample];
        assert.equal(result.status, "native", JSON.stringify(result));
        assert.deepEqual(result.request, cases[index].requests[sample]);
        assert.deepEqual(result.size, [record.width, record.height]);
        assert.deepEqual(result.bounds, [
          record.bounds.x,
          record.bounds.y,
          record.bounds.width,
          record.bounds.height,
        ]);
        assert.deepEqual(
          result.layout.lines.map((l) => l.text),
          record.wrapped_lines,
        );
        const draws = record.draws.filter((d) => d.operation === "fillText");
        assert.equal(result.paints.length, draws.length);
        const deltas = {
          advance: 0,
          baseline: 0,
          transform: 0,
          cluster_advance: 0,
          cluster_position: 0,
        };
        for (const [i, paint] of result.paints.entries()) {
          const draw = draws[i],
            matrix = draw.transform;
          assert.equal(paint.text, draw.text);
          if (options.fixtureManifest) {
            const shape = auditNativeShape(
              {
                width: draw.metrics.width,
                baseline: draw.metrics.alphabeticBaseline,
                clusters: draw.clusters.map((c) => ({
                  start: c.start,
                  end: c.end,
                  x: c.x,
                  width: c.selectionRects.reduce((n, r) => n + r.width, 0),
                })),
              },
              paint.shaped,
            );
            assert(shape.passed && shape.one_native_glyph_per_cluster, JSON.stringify(shape));
            deltas.cluster_advance = Math.max(deltas.cluster_advance, shape.deltas.cluster_advance);
            deltas.cluster_position = Math.max(
              deltas.cluster_position,
              shape.deltas.cluster_position,
            );
          }
          deltas.advance = Math.max(
            deltas.advance,
            Math.abs(paint.shaped.advance - draw.metrics.width),
          );
          deltas.baseline = Math.max(
            deltas.baseline,
            Math.abs(paint.shaped.middle_baseline_offset + draw.metrics.alphabeticBaseline),
          );
          const expectedMatrix = [
            matrix[0],
            matrix[1],
            matrix[4],
            matrix[5],
            matrix[0] * draw.x + matrix[4] * draw.y + matrix[12],
            matrix[1] * draw.x + matrix[5] * draw.y + matrix[13],
          ];
          const scale = record.scale,
            yscale = record.height / record.bounds.height / scale;
          const [a, b, c, d, e, f] = paint.transform;
          const actual = [
            a,
            b * yscale,
            c,
            d * yscale,
            e - record.bounds.x * scale,
            (f - record.bounds.y * scale) * yscale,
          ];
          for (let component = 0; component < 6; component++)
            deltas.transform = Math.max(
              deltas.transform,
              Math.abs(actual[component] - expectedMatrix[component]),
            );
          assert(
            Math.abs(paint.stroke_radius * 2 - draw.lineWidth) < 1e-5 || paint.stroke_radius === 0,
          );
          assert.equal(paint.blur, 0);
        }
        for (const [key, value] of Object.entries(deltas)) {
          report.maxima[key] = Math.max(report.maxima[key], value);
          assert(
            Number.isFinite(value) && value <= 0.5,
            `${selected[index]} ${sample} ${key}: ${value}`,
          );
        }
        assert(result.draws > 0 && result.atlas_bytes > 0 && result.zero_full_layer_cpu_rasters);
        report.comparisons.push({
          case_id: selected[index],
          sample,
          paints: result.paints.length,
          deltas,
          bounds_exact: true,
          native_recipe_admitted: true,
          per_glyph_observed: Boolean(options.fixtureManifest),
        });
      }
    }
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
