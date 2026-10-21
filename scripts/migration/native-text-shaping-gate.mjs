import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./m0-evidence.mjs";
import { auditNativeTextRasters } from "./native-text-raster-audit.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export function parseCanvasFont(value) {
  const match =
    /^(?:(italic|oblique)\s+)?(?:(bold|normal|[1-9]\d{0,2}|1000)\s+)?(\d+(?:\.\d+)?)px\s+(.+)$/.exec(
      value,
    );
  assert(match && match[1] !== "oblique", `Unsupported observed CSS font: ${value}`);
  const families = [],
    source = match[4];
  let current = "",
    quoted = false,
    escaped = false;
  for (const ch of source) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      families.push(current.trim());
      current = "";
    } else current += ch;
  }
  assert(!quoted && !escaped);
  families.push(current.trim());
  assert(families.every((f) => f.length > 0));
  return {
    font: {
      families,
      weight:
        match[2] === "bold" ? 700 : match[2] === "normal" || !match[2] ? 400 : Number(match[2]),
      italic: match[1] === "italic",
    },
    size: Number(match[3]),
  };
}

export function auditNativeShape(expected, shaped) {
  const deltas = {
    advance: Math.abs(shaped.advance - expected.width),
    baseline: Math.abs(shaped.middle_baseline_offset + expected.baseline),
    cluster_advance: 0,
    cluster_position: 0,
  };
  const groups = new Map();
  let cursor = 0;
  for (const glyph of shaped.glyphs) {
    const key = `${glyph.cluster_start}:${glyph.cluster_end}`;
    const group = groups.get(key) ?? { x: cursor, width: 0, glyphs: 0 };
    group.width += glyph.advance[0];
    group.glyphs++;
    groups.set(key, group);
    cursor += glyph.advance[0];
  }
  let observable = groups.size === expected.clusters.length;
  let oneGlyph = true;
  for (const cluster of expected.clusters) {
    const group = groups.get(`${cluster.start}:${cluster.end}`);
    if (!group) {
      observable = false;
      continue;
    }
    oneGlyph &&= group.glyphs === 1;
    deltas.cluster_advance = Math.max(
      deltas.cluster_advance,
      Math.abs(group.width - cluster.width),
    );
    deltas.cluster_position = Math.max(deltas.cluster_position, Math.abs(group.x - cluster.x));
  }
  return {
    passed: observable && Object.values(deltas).every((v) => Number.isFinite(v) && v <= 0.5),
    deltas,
    cluster_mapping_observable: observable,
    one_native_glyph_per_cluster: oneGlyph,
  };
}

/** Compare native output with authenticated actual Canvas observations, without claiming raster parity. */
export async function runNativeTextShapingGate(
  context,
  observationRoot,
  execute = runStep,
  binaryOverride,
  rasterize = false,
) {
  const report = {
    status: "failed",
    scope: "native-text-layout-components-v1",
    queries: [],
    unsupported: [],
    native_raster: false,
    strict_glyph_acceptance: false,
  };
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    const hostPath = join(observationRoot, "extended/report.json");
    report.observations = { path: local(hostPath), sha256: await hashFile(hostPath) };
    const host = JSON.parse(await readFile(hostPath));
    assert.equal(host.status, "passed");
    const entries = new Map();
    let records = 0,
      draws = 0;
    const add = (font, query, expected) => {
      const id = sha256(Buffer.from(JSON.stringify({ font, query })));
      const prior = entries.get(id);
      if (prior) {
        assert.deepEqual(prior.expected, expected, "Identical text request has changing metrics");
        prior.uses++;
      } else entries.set(id, { id, font, query, expected, uses: 1 });
    };
    for (const item of host.cases)
      for (const observation of item.observations) {
        assert.equal(
          item.project_fonts_sha256,
          sha256(Buffer.from("[]")),
          "Embedded-font requests require project font admission before native comparison",
        );
        const path = join(observationRoot, "extended", item.id, observation.path);
        assert.equal(await hashFile(path), observation.sha256);
        const sample = JSON.parse(await readFile(path));
        for (const record of sample.records) {
          records++;
          for (const draw of record.draws) {
            draws++;
            const parsed = parseCanvasFont(draw.font);
            add(
              parsed.font,
              {
                kind: "shape",
                text: draw.text,
                size: parsed.size,
                direction: draw.direction === "rtl" ? "right_to_left" : "left_to_right",
                language: host.host.segmentation_locale,
              },
              {
                width: draw.metrics.width,
                baseline: draw.metrics.alphabeticBaseline,
                clusters: draw.clusters.map((c) => ({
                  start: c.start,
                  end: c.end,
                  x: c.x,
                  width: c.selectionRects.reduce((sum, r) => sum + r.width, 0),
                })),
              },
            );
          }
          if (record.layout_input) {
            const parsed = parseCanvasFont(record.layout_font);
            const anchors = record.layout_origins;
            assert(Array.isArray(anchors) && anchors.length === record.wrapped_lines.length);
            assert(anchors.every((a) => a.length === 2 && a.every(Number.isFinite)));
            add(
              parsed.font,
              { kind: "layout", request: record.layout_input },
              { lines: record.wrapped_lines, anchors },
            );
          }
        }
      }
    assert(entries.size > 0 && entries.size <= 25_000);
    const input = join(context.output, "requests.json"),
      output = join(context.output, "native.json");
    await writeAtomicJson(
      input,
      [...entries.values()].map(({ id, font, query }) => ({ id, font, query })),
    );
    const binary =
      binaryOverride ??
      join(
        context.root,
        "target/release",
        process.platform === "win32" ? "aster-render-cli.exe" : "aster-render-cli",
      );
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    report.input = { path: local(input), sha256: await hashFile(input) };
    report.step = await execute(
      {
        id: "native-text-shaping",
        file: binary,
        args: [
          "text-layout",
          "--input",
          input,
          "--out",
          output,
          "--max-catalog-bytes",
          "1073741824",
          ...(rasterize ? ["--rasterize"] : []),
        ],
        timeout_ms: 600_000,
      },
      context,
    );
    assert.equal(report.step.status, "passed");
    const native = JSON.parse(await readFile(output));
    assert.equal(native.input_sha256, report.input.sha256);
    assert.equal(native.results.length, entries.size);
    const seen = new Set();
    for (const result of native.results) {
      assert(entries.has(result.id) && !seen.has(result.id));
      seen.add(result.id);
      const entry = entries.get(result.id);
      if (result.error) {
        assert.match(
          result.error,
          /requires retained rendering|no admitted fallback font covers|Requested font families unavailable/,
        );
        report.unsupported.push({ id: result.id, reason: result.error, uses: entry.uses });
        continue;
      }
      if (entry.query.kind === "shape") {
        const audit = auditNativeShape(entry.expected, result.shaped);
        report.queries.push({ id: result.id, kind: "shape", uses: entry.uses, ...audit });
      } else {
        const lines = result.layout.lines.map((l) => l.text);
        const baseline_delta = entry.expected.anchors.reduce(
          (maximum, anchor, index) =>
            Math.max(
              maximum,
              Math.abs((result.layout.lines[index]?.origin[0] ?? Infinity) - anchor[0]),
              Math.abs((result.layout.lines[index]?.origin[1] ?? Infinity) - anchor[1]),
            ),
          0,
        );
        report.queries.push({
          id: result.id,
          kind: "layout",
          uses: entry.uses,
          baseline_delta,
          passed:
            JSON.stringify(lines) === JSON.stringify(entry.expected.lines) && baseline_delta <= 0.5,
        });
      }
    }
    report.coverage = {
      records,
      draws,
      unique_requests: entries.size,
      native_requests: report.queries.length,
      unsupported_requests: report.unsupported.length,
    };
    report.native_output = { path: local(output), sha256: await hashFile(output) };
    if (rasterize)
      report.raster_components = await auditNativeTextRasters(
        context.output,
        native.raster_components,
        [...entries.values()],
        native.results,
      );
    assert(report.queries.length > 0);
    assert(
      report.queries.every((q) => q.passed),
      "Native text metrics or wrapped lines differ",
    );
    assert.equal(await hashFile(binary), report.binary.sha256);
    assert.equal(await hashFile(hostPath), report.observations.sha256);
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
