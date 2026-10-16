import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sceneSupplementScope, validateM7Gates, validateNativeSceneGates } from "./m7-scope.mjs";
import { coreCases } from "./native-core-scope.mjs";
import { nativeEffectCases } from "./native-effect-scope.mjs";
import { nativeRasterCases } from "./native-raster-batch.mjs";
import { nativeSceneCases } from "./native-scene-batch.mjs";
import { nativeSequenceCases } from "./native-sequence-gate.mjs";
import { nativeVideoCases } from "./native-video-gate.mjs";
import { staticCommands } from "./static-checks.mjs";

test("M7 rejects incomplete, duplicate, stale and falsely summarized scene evidence", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("../../tests/parity/corpus.json", import.meta.url)),
  );
  const step = {
    status: "passed",
    exit_code: 0,
    started_at: "2026-10-08T00:00:01Z",
    finished_at: "2026-10-08T00:00:02Z",
  };
  const frames = (ids) =>
    corpus.cases
      .filter((c) => ids.includes(c.id))
      .flatMap((c) => c.frames.map((frame) => ({ case_id: c.id, frame })));
  const cases = [...coreCases, ...nativeEffectCases, ...nativeRasterCases, ...nativeSceneCases];
  const native = {
    id: "G3",
    status: "passed",
    scope: "native-scene-depth-v1",
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
    scene_batch: {
      status: "passed",
      step,
      frames: frames(nativeSceneCases).length,
      executions: frames(nativeSceneCases).length + 3,
    },
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
  for (const scope of sceneSupplementScope())
    native[scope.name] = {
      status: "passed",
      frames: scope.ids.map((id) => ({ case_id: `${scope.prefix}-${id}`, frame: 0, step })),
      controls: Array.from({ length: scope.controls }, () => ({ changed_bytes: 17 })),
      exact_cache_comparisons:
        scope.ids.length + (scope.name === "native_generator_surfaces" ? 3 : 0),
      batches: [step, step],
    };
  native.native_generator_surfaces.exact_restorations = 6;
  native.native_generator_surfaces.rejections = Array.from({ length: 12 }, () => ({}));
  native.native_generator_audio = {
    status: "passed",
    step,
    exact_replays: 6,
    controls: ["bars", "ring", "scope"].map((kind) => ({ kind })),
    rejections: [{}, {}, {}],
  };
  const report = {
    milestone: "M7",
    mode: "full",
    required_gates: ["G0", "G3"],
    started_at: "2026-10-08T00:00:00Z",
    gates: [
      { id: "G0", status: "passed", steps: staticCommands().map(({ id }) => ({ ...step, id })) },
      native,
    ],
  };
  validateM7Gates(report, corpus);
  const exportReport = structuredClone(report);
  exportReport.milestone = "M8";
  exportReport.required_gates.push("G4", "G5", "G6");
  exportReport.gates.push(...["G4", "G5", "G6"].map((id) => ({ id, status: "passed" })));
  validateNativeSceneGates(exportReport, corpus, "M8");
  assert.throws(() => validateM7Gates(exportReport, corpus));
  assert.throws(() => validateNativeSceneGates(report, corpus, "M8"));
  for (const id of ["G4", "G5", "G6"]) {
    const missing = structuredClone(exportReport);
    missing.gates = missing.gates.filter((g) => g.id !== id);
    assert.throws(() => validateNativeSceneGates(missing, corpus, "M8"));
    const failed = structuredClone(exportReport);
    failed.gates.find((g) => g.id === id).status = "failed";
    assert.throws(() => validateNativeSceneGates(failed, corpus, "M8"));
  }
  for (const change of [
    (r) => {
      r.mode = "quick";
    },
    (r) => {
      r.gates[0].steps.pop();
    },
    (r) => {
      r.gates[1].native_videos.frames.pop();
    },
    (r) => {
      r.gates[1].cases = r.gates[1].cases.filter((id) => id !== "scene-cloners");
    },
    (r) => {
      r.gates[1].scene_batch.executions--;
    },
    (r) => {
      r.gates[1].scene_batch.step.started_at = "2000-01-01T00:00:00Z";
    },
    (r) => {
      r.gates[1].native_generator_surfaces.frames.pop();
    },
    (r) => {
      r.gates[1].native_generator_output.frames[1] = r.gates[1].native_generator_output.frames[0];
    },
    (r) => {
      r.gates[1].native_generator_surfaces.exact_restorations = 5;
    },
    (r) => {
      r.gates[1].native_generator_surfaces.rejections.pop();
    },
    (r) => {
      r.gates[1].native_scene_output.exact_cache_comparisons--;
    },
    (r) => {
      r.gates[1].native_normal.controls[0].changed_bytes = 0;
    },
    (r) => {
      r.gates[1].native_animated_normal.status = "failed";
    },
    (r) => {
      r.gates[1].native_material.frames[0].frame = 1;
    },
    (r) => {
      r.gates[1].native_generator_audio.exact_replays--;
    },
    (r) => {
      r.gates[1].native_generator_audio.controls[1].kind = "bars";
    },
    (r) => {
      r.gates[1].full_coverage = false;
    },
  ]) {
    const changed = structuredClone(report);
    change(changed);
    assert.throws(() => validateM7Gates(changed, corpus));
  }
});
