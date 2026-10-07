import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateMediaCache } from "./m6-cache.mjs";
import { validateM6Gates } from "./m6-gates.mjs";
import { coreCases } from "./native-core-scope.mjs";
import { nativeEffectCases } from "./native-effect-scope.mjs";
import { nativeRasterCases } from "./native-raster-batch.mjs";
import { nativeSequenceCases } from "./native-sequence-gate.mjs";
import { nativeVideoCases } from "./native-video-gate.mjs";
import { staticCommands } from "./static-checks.mjs";

test("M6 rejects missing media, stale execution, incomplete gates and forged coverage", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("../../tests/parity/corpus.json", import.meta.url)),
  );
  const step = {
    status: "passed",
    exit_code: 0,
    started_at: "2026-10-07T00:00:01Z",
    finished_at: "2026-10-07T00:00:02Z",
  };
  const frames = (ids) =>
    corpus.cases
      .filter((c) => ids.includes(c.id))
      .flatMap((c) => c.frames.map((frame) => ({ case_id: c.id, frame })));
  const cases = [...coreCases, ...nativeEffectCases, ...nativeRasterCases];
  const native = {
    id: "G3",
    status: "passed",
    scope: "native-media-mixed-v1",
    full_coverage: true,
    milestone_exit_eligible: true,
    native_gpu_execution: true,
    cases,
    frames: frames(cases),
    required_count: frames(cases).length,
    build: step,
    image_cache: step,
    effect_batch: { step },
    raster_batch: { step },
  };
  for (const name of [
    "native_stills",
    "native_exr",
    "native_surface_post",
    "native_auxiliary_primary",
    "native_surface_frames",
    "native_layer_cache",
    "native_ssaa_effect_evaluation",
    "native_temporal_text",
    "native_temporal_frames",
    "native_motion_frames",
    "native_sequences",
    "native_videos",
    "native_media_frames",
  ])
    native[name] = { status: "passed" };
  native.native_sequences.frames = frames(nativeSequenceCases);
  native.native_videos.frames = frames(nativeVideoCases);
  native.native_videos.decode_cache = { exact_comparisons: 148 };
  native.native_media_frames.frames = Array.from({ length: 6 }, () => ({}));
  native.native_layer_cache.exact = (native.required_count + 16) * 4;
  native.native_layer_cache.frames = Array.from(
    { length: native.native_layer_cache.exact },
    () => ({}),
  );
  const report = {
    milestone: "M6",
    mode: "full",
    required_gates: ["G0", "G3"],
    started_at: "2026-10-07T00:00:00Z",
    gates: [
      { id: "G0", status: "passed", steps: staticCommands().map(({ id }) => ({ ...step, id })) },
      native,
    ],
  };
  validateM6Gates(report, corpus);
  for (const mutate of [
    (r) => {
      r.mode = "quick";
    },
    (r) => {
      r.gates[0].steps.pop();
    },
    (r) => {
      r.gates[0].steps[0].started_at = "2000-01-01T00:00:00Z";
    },
    (r) => {
      r.gates[1].status = "failed";
    },
    (r) => {
      r.gates[1].native_videos.frames.pop();
    },
    (r) => {
      r.gates[1].native_sequences.frames[1] = r.gates[1].native_sequences.frames[0];
    },
    (r) => {
      r.gates[1].native_media_frames.status = "failed";
    },
    (r) => {
      r.gates[1].native_videos.decode_cache.exact_comparisons = 147;
    },
    (r) => {
      r.gates[1].frames.pop();
    },
    (r) => {
      r.gates[1].milestone_exit_eligible = false;
    },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => validateM6Gates(changed, corpus));
  }
});

test("decode cache audit rejects invented reuse and missing eviction", () => {
  const state = (frame, values) => ({
    native_images: [{ frame, width: 2, height: 2 }],
    media_decode_cache: {
      budget_bytes: 16,
      entry_limit: 1,
      resident_bytes: 16,
      entries: 1,
      ...values,
    },
  });
  const receipts = [
    state("a", { hits: 0, misses: 1, decodes: 1, evictions: 0 }),
    state("a", { hits: 1, misses: 1, decodes: 1, evictions: 0 }),
    state("b", { hits: 1, misses: 2, decodes: 2, evictions: 1 }),
    state("a", { hits: 1, misses: 3, decodes: 3, evictions: 2 }),
  ];
  validateMediaCache(receipts, 16, 1);
  for (const key of ["hits", "misses", "decodes", "evictions", "resident_bytes", "entries"]) {
    const changed = structuredClone(receipts);
    changed.at(-1).media_decode_cache[key]++;
    assert.throws(() => validateMediaCache(changed, 16, 1));
  }
  assert.throws(() => validateMediaCache(receipts, 0, 1));
});
