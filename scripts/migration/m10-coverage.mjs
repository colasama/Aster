import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256, validSha } from "./m0-evidence.mjs";

/** Reconstruct text-bearing cases from authored projects, including the owner project. */
export async function auditM10Coverage(root, reader, corpus, layout, tasks, env) {
  const expected = [];
  for (const item of corpus.cases) {
    let path =
      item.project === "env:ASTER_PERF_PROJECT" ? env.ASTER_PERF_PROJECT : join(root, item.project);
    assert(path, "Owner project unavailable");
    if ((await stat(path)).isDirectory()) path = join(path, "project.json");
    const bytes = await readFile(path),
      project = JSON.parse(bytes);
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
    if (!authored.length) continue;
    expected.push(item.id);
    const entry = layout.cases.find((c) => c.id === item.id);
    assert(entry, `Text case omitted: ${item.id}`);
    assert.equal(entry.project_sha256, sha256(bytes));
    assert.deepEqual(entry.authored, authored);
    const ordinary = await reader.json(entry.ordinary.path, entry.ordinary.sha256);
    const extended = await reader.json(entry.extended.path, entry.extended.sha256);
    const a = ordinary.cases.find((c) => c.id === item.id),
      b = extended.cases.find((c) => c.id === item.id);
    assert.equal(a.project_sha256, entry.project_sha256);
    assert.equal(b.project_sha256, entry.project_sha256);
    assert.deepEqual(a.samples, b.samples);
    assert.equal(a.samples.length, entry.samples);
    assert.equal(a.observations.length, entry.samples);
    assert.equal(b.observations.length, entry.samples);
    assert.equal(a.samples.filter((s) => s.scope === "random-corpus").length, 64);
    const composition = project.compositions.find((c) => c.id === item.composition);
    const rate = composition.frameRate.numerator / composition.frameRate.denominator;
    for (const frame of item.frames)
      assert(
        a.samples.some(
          (s) =>
            s.scope === "declared-corpus" &&
            s.composition === composition.id &&
            s.time === frame / rate &&
            s.scale ===
              Math.max(item.size.width / composition.width, item.size.height / composition.height),
        ),
      );
    assert.equal(new Set(entry.observed_layers).size, entry.observed_layers.length);
    const excluded = authored.filter(
      (l) => !entry.observed_layers.includes(`${l.composition}/${l.layer}`),
    );
    assert.equal(excluded.length, entry.excluded_layers.length);
    for (const layer of excluded) {
      const reason = !layer.visible
        ? "authored-hidden"
        : layer.outPoint <= 0 ||
            layer.inPoint >=
              project.compositions.find((c) => c.id === layer.composition).duration ||
            layer.outPoint <= layer.inPoint
          ? "outside-composition-time-range"
          : null;
      assert(reason, "Eligible text layer omitted");
      assert(
        entry.excluded_layers.some(
          (e) => JSON.stringify(e) === JSON.stringify({ ...layer, reason }),
        ),
      );
    }
    assert.equal(
      sha256(await readFile(path)),
      entry.project_sha256,
      "Project changed during exit audit",
    );
  }
  assert.deepEqual(
    layout.cases.map((c) => c.id),
    expected,
  );
  return assertM10Routing(layout, tasks);
}

/** Retention must be explicit, exact, and accounted for by a ledger capability task. */
export function assertM10Routing(layout, tasks) {
  assert.equal(layout.native_text_routing.status, "passed");
  assert.equal(layout.native_text_routing.full_coverage, true);
  assert.deepEqual(
    layout.native_text_routing.cases.map((c) => c.id),
    layout.cases.map((c) => c.id),
  );
  assert(Array.isArray(tasks) && tasks.length > 0, "Retained capability tasks missing");
  const coverage = [];
  for (const entry of layout.cases) {
    const routed = layout.native_text_routing.cases.find((c) => c.id === entry.id);
    assert.equal(routed.frames.length, entry.samples);
    assert.equal(routed.records, entry.records);
    const sums = { records: 0, native: 0, retained: 0, exact_pixels: 0, temporal_samples: 0 },
      reasons = {};
    for (const frame of routed.frames) {
      for (const key of Object.keys(sums)) {
        assert(Number.isSafeInteger(frame[key]) && frame[key] >= 0);
        sums[key] += frame[key];
      }
      assert.equal(frame.requests, frame.native + frame.retained);
      assert.equal(
        frame.records,
        frame.native_records.length + frame.exact_pixels + frame.temporal_samples,
      );
      assert.equal(frame.native_records.length, frame.native);
      if (!frame.temporal_samples) assert.equal(frame.exact_pixels, frame.retained);
      for (const record of frame.native_records) validSha(record.rgba_sha256);
      for (const [reason, count] of Object.entries(frame.reasons)) {
        assert(Number.isSafeInteger(count) && count > 0);
        reasons[reason] = (reasons[reason] ?? 0) + count;
        if (reason === "ordinary outline fill through the platform glyph atlas") {
          assert.equal(count, frame.native);
          continue;
        }
        assert(
          tasks.some(
            (t) =>
              t.status === "verified_retained" &&
              t.route === "M5" &&
              t.cases.includes(entry.id) &&
              t.reasons.includes(reason),
          ),
          `Unrecorded retained capability: ${entry.id}: ${reason}`,
        );
      }
    }
    for (const [key, count] of Object.entries(sums)) assert.equal(routed[key], count);
    assert.deepEqual(routed.reasons, reasons);
    coverage.push({ id: entry.id, samples: entry.samples, ...sums, reasons });
  }
  assert(
    coverage.some((c) => c.native > 0),
    "Blanket retention cannot establish native text migration",
  );
  return coverage;
}
