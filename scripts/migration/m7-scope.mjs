import assert from "node:assert/strict";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { validateNativeMediaGates } from "./m6-gates.mjs";
import { nativeSceneCases } from "./native-scene-batch.mjs";

const aaModes = ["off", "fxaa", "ssaa2x", "ssaa4x"];
const lights = ["directional", "point", "spot"];
const kinds = ["billboard", "mesh", "streak", "bars", "ring", "scope"];

/** Independent required identities prevent duplicate or omitted frames from satisfying coverage. */
export function sceneSupplementScope() {
  return [
    {
      name: "native_scene_output",
      prefix: "native-scene-output",
      controls: 16,
      ids: aaModes.flatMap((aa) => [
        ...[0, 1, 2].flatMap((tier) =>
          ["still", "motion"].map((motion) => `depthOfField-${aa}-k${tier}-${motion}-ready`),
        ),
        `depthFog-${aa}-k0-still-ready`,
        `depthOfField-${aa}-k0-still-skipped`,
        ...[
          "linearColor",
          "luminance",
          "alpha",
          "normal",
          "objectId",
          "materialId",
          "worldPosition",
          "motionVector",
        ].map((mode) => `${mode}-${aa}-k-1-still-ready`),
      ]),
    },
    {
      name: "native_material",
      prefix: "native-material",
      controls: 44,
      ids: lights.flatMap((light) =>
        aaModes.flatMap((aa) =>
          ["fallback", "hdr", "rotated", "replaced", "unshadowed"].map(
            (mode) => `${light}-${aa}-${mode}`,
          ),
        ),
      ),
    },
    {
      name: "native_normal",
      prefix: "native-normal",
      controls: 108,
      ids: lights.flatMap((light) =>
        aaModes.flatMap((aa) =>
          ["png", "jpeg", "webp"].flatMap((encoding) =>
            ["normal", "negative", "zero", "combined"].map(
              (mode) => `${light}-${aa}-${encoding}-${mode}`,
            ),
          ),
        ),
      ),
    },
    {
      name: "native_animated_normal",
      prefix: "native-animated-normal",
      controls: 12,
      ids: aaModes.flatMap((aa) =>
        ["full", "offset-blend", "offset-replace"].flatMap((variant) =>
          ["normal", "zero"].map((mode) => `directional-${aa}-${variant}-${mode}`),
        ),
      ),
    },
    {
      name: "native_generator_output",
      prefix: "native-generator-output",
      controls: 24,
      ids: kinds.flatMap((kind) =>
        aaModes.flatMap((aa) =>
          [
            "normal",
            "objectId",
            "materialId",
            "worldPosition",
            "motionVector",
            "beauty",
            "beauty-motion",
            "depthOfField",
            "empty",
          ].map((mode) => `${kind}-${aa}-${mode}`),
        ),
      ),
    },
    {
      name: "native_generator_surfaces",
      prefix: "native-generator-surface",
      controls: 36,
      ids: kinds.flatMap((kind) =>
        aaModes.flatMap((aa) =>
          [
            "child",
            "nested",
            "unavailable",
            ...(["bars", "ring", "scope"].includes(kind) ? ["shared", "inherited", "silent"] : []),
          ].map((mode) => `${kind}-${aa}-${mode}`),
        ),
      ),
    },
  ];
}

export function validateM7Gates(report, corpus) {
  return validateNativeSceneGates(report, corpus, "M7");
}

export function validateNativeSceneGates(report, corpus, milestone) {
  assert(["M7", "M8"].includes(milestone));
  const result = validateNativeMediaGates(report, corpus, {
    milestone,
    scope: "native-scene-depth-v1",
    additionalCases: nativeSceneCases,
    requiredGates: milestone === "M8" ? ["G0", "G3", "G4", "G5", "G6"] : ["G0", "G3"],
  });
  const { native } = result;
  const requiredFeatures = [
    "feature:camera",
    "feature:depth-of-field",
    "feature:lights",
    "feature:shadows",
    "feature:meshes",
    "feature:hdr-environment",
    "feature:motion-blur",
    "feature:bundled-particles",
    "feature:audio-analysis",
    "feature:cloner",
  ];
  for (const feature of requiredFeatures) {
    const cases = corpus.cases.filter((c) => c.features.includes(feature));
    assert(cases.length > 0, `Missing scene feature ${feature}`);
    assert(
      cases.every((c) => native.cases.includes(c.id)),
      `Unexecuted scene feature ${feature}`,
    );
  }
  assert.equal(native.scene_batch.status, "passed");
  validateCurrentStep(native.scene_batch.step, report.started_at);
  assert.equal(
    native.scene_batch.frames,
    native.frames.filter((f) => nativeSceneCases.includes(f.case_id)).length,
  );
  assert.equal(native.scene_batch.executions, native.scene_batch.frames + 3);
  for (const { name, prefix, controls, ids } of sceneSupplementScope()) {
    const group = native[name];
    assert.equal(group?.status, "passed", `Missing scene supplement ${name}`);
    assert.deepEqual(
      group.frames.map((f) => [f.case_id, f.frame]),
      ids.map((id) => [`${prefix}-${id}`, 0]),
    );
    assert.equal(group.controls.length, controls);
    assert(group.controls.every((c) => c.changed_bytes > 16));
    assert.equal(
      group.exact_cache_comparisons,
      ids.length + (name === "native_generator_surfaces" ? 3 : 0),
    );
    assert.equal(group.batches.length, 2);
    for (const batch of group.batches) validateCurrentStep(batch.step ?? batch, report.started_at);
    for (const frame of group.frames) validateCurrentStep(frame.step, report.started_at);
  }
  assert.equal(native.native_generator_surfaces.exact_restorations, 6);
  assert.equal(native.native_generator_surfaces.rejections.length, 12);
  const audio = native.native_generator_audio;
  assert.equal(audio.status, "passed");
  validateCurrentStep(audio.step, report.started_at);
  assert.deepEqual(
    audio.controls.map((c) => c.kind),
    ["bars", "ring", "scope"],
  );
  assert.equal(audio.exact_replays, 6);
  assert.equal(audio.rejections.length, 3);
  return result;
}
