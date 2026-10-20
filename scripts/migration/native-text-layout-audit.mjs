import assert from "node:assert/strict";

/** Clusters cover UTF-16 input spans; they are not a claim about raw glyph IDs. */
export function assertTextLayoutPair(baseline, candidate) {
  assert.deepEqual(candidate.sample, baseline.sample);
  assert.equal(candidate.records.length, baseline.records.length);
  for (const [index, record] of candidate.records.entries()) {
    const { image: _image, ...observed } = structuredClone(record);
    assert.equal(observed.observation_neutral, true);
    assert.equal(observed.raw_glyph_identity_available, false);
    assert.equal(observed.cluster_geometry_only, true);
    for (const draw of observed.draws) {
      assert(Array.isArray(draw.clusters));
      let covered = 0;
      for (const cluster of draw.clusters) {
        assert(Number.isFinite(cluster.x) && Number.isFinite(cluster.y));
        assert(
          Number.isInteger(cluster.start) &&
            Number.isInteger(cluster.end) &&
            cluster.start >= 0 &&
            cluster.end <= draw.text.length &&
            cluster.start < cluster.end,
        );
        assert.equal(cluster.start, covered, "Text cluster coverage has gaps or overlaps");
        assert(Array.isArray(cluster.selectionRects), "Cluster advance bounds missing");
        for (const rect of cluster.selectionRects) {
          for (const key of ["x", "y", "width", "height"]) assert(Number.isFinite(rect[key]));
          assert(rect.width >= 0 && rect.height >= 0);
        }
        covered = cluster.end;
      }
      assert.equal(covered, draw.text.length, "Text clusters omit input code units");
      draw.clusters = null;
    }
    assert.deepEqual(
      observed,
      baseline.records[index],
      "Extended metrics changed production layout or pixels",
    );
  }
}
