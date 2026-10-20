import assert from "node:assert/strict";
import test from "node:test";
import { assertTextLayoutPair } from "./native-text-layout-audit.mjs";

function pair() {
  const baseline = {
    sample: { composition: "comp", time: 0, scale: 1 },
    records: [
      {
        layer: "text",
        observation_neutral: true,
        raw_glyph_identity_available: false,
        cluster_geometry_only: true,
        rgba_sha256: "pixels",
        wrapped_lines: ["AB"],
        draws: [
          {
            text: "AB",
            font: "400 48px Arial",
            metrics: { width: 60 },
            transform: [1, 0, 0, 1, 0, 0],
            clusters: null,
          },
        ],
      },
    ],
  };
  const candidate = structuredClone(baseline);
  candidate.records[0].image = { path: "0.png", sha256: "image" };
  candidate.records[0].draws[0].clusters = [0, 1].map((index) => ({
    start: index,
    end: index + 1,
    x: index * 30,
    y: 0,
    selectionRects: [{ x: index * 30, y: -20, width: 30, height: 48 }],
  }));
  return { baseline, candidate };
}

test("layout audit binds ordinary and instrumented geometry, source text and pixels", () => {
  const { baseline, candidate } = pair();
  assertTextLayoutPair(baseline, candidate);
  for (const mutate of [
    (value) => {
      value.sample.time = 1;
    },
    (value) => {
      value.records[0].rgba_sha256 = "different";
    },
    (value) => {
      value.records[0].wrapped_lines = ["A", "B"];
    },
    (value) => {
      value.records[0].draws[0].font = "400 48px Other";
    },
    (value) => {
      value.records[0].draws[0].metrics.width = 61;
    },
    (value) => {
      value.records[0].draws[0].transform[4] = 1;
    },
    (value) => {
      value.records[0].raw_glyph_identity_available = true;
    },
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.throws(() => assertTextLayoutPair(baseline, changed));
  }
});

test("layout audit rejects missing, overlapping, nonfinite and unbounded cluster observations", () => {
  for (const mutate of [
    (clusters) => clusters.pop(),
    (clusters) => {
      clusters[1].start = 0;
    },
    (clusters) => {
      clusters[1].end = 3;
    },
    (clusters) => {
      clusters[0].x = NaN;
    },
    (clusters) => {
      delete clusters[0].selectionRects;
    },
    (clusters) => {
      clusters[0].selectionRects[0].width = -1;
    },
  ]) {
    const { baseline, candidate } = pair();
    mutate(candidate.records[0].draws[0].clusters);
    assert.throws(() => assertTextLayoutPair(baseline, candidate));
  }
});
