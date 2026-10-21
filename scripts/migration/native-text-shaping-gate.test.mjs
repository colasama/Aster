import assert from "node:assert/strict";
import test from "node:test";
import { auditNativeShape, parseCanvasFont } from "./native-text-shaping-gate.mjs";

test("native font observation preserves CSS family order, size and weight", () => {
  assert.deepEqual(parseCanvasFont('italic bold 30.5px "A, B", Arial, sans-serif'), {
    size: 30.5,
    font: { families: ["A, B", "Arial", "sans-serif"], weight: 700, italic: true },
  });
  assert.equal(parseCanvasFont("30px Arial").font.weight, 400);
  for (const value of ["oblique 30px Arial", '30px "broken', "bad", "30px Arial,"])
    assert.throws(() => parseCanvasFont(value));
});

test("native metric audit cannot hide advance, baseline or cluster displacement", () => {
  const expected = {
    width: 20,
    baseline: -6,
    clusters: [
      { start: 0, end: 1, x: 0, width: 10 },
      { start: 1, end: 2, x: 10, width: 10 },
    ],
  };
  const native = {
    advance: 20,
    middle_baseline_offset: 6,
    glyphs: [
      { cluster_start: 0, cluster_end: 1, advance: [10, 0] },
      { cluster_start: 1, cluster_end: 2, advance: [10, 0] },
    ],
  };
  assert.equal(auditNativeShape(expected, native).passed, true);
  for (const change of [
    (n) => {
      n.advance = 21;
    },
    (n) => {
      n.middle_baseline_offset = 7;
    },
    (n) => {
      n.glyphs[0].advance[0] = 11;
      n.glyphs[1].advance[0] = 9;
    },
  ]) {
    const changed = structuredClone(native);
    change(changed);
    assert.equal(auditNativeShape(expected, changed).passed, false);
  }
  const missing = structuredClone(native);
  missing.glyphs.pop();
  assert.equal(auditNativeShape(expected, missing).cluster_mapping_observable, false);
  assert.equal(auditNativeShape(expected, missing).passed, false);
});
