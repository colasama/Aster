import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureAudioOracle } from "./native-audio-oracle.mjs";
import { captureAuxiliaryOracle } from "./native-auxiliary-oracle.mjs";
import { captureBundleOracle } from "./native-bundle-oracle.mjs";
import { captureCameraOracle } from "./native-camera-oracle.mjs";
import { captureClonerOracle } from "./native-cloner-oracle.mjs";
import { captureEffectInputOracle } from "./native-effect-input-oracle.mjs";
import { captureEffectPlanOracle } from "./native-effect-plan-oracle.mjs";
import { captureEffectProgramOracle } from "./native-effect-program-oracle.mjs";
import { captureGeneratorOracle } from "./native-generator-oracle.mjs";
import { captureLightingMeshOracle } from "./native-lighting-mesh-oracle.mjs";
import { capturePlanOracle } from "./native-plan-oracle.mjs";
import { capturePostEffectOracle } from "./native-post-effect-oracle.mjs";
import { captureProjectFrameOracle } from "./native-project-frame-oracle.mjs";
import { captureShapeGraphOracle } from "./native-shape-graph-oracle.mjs";
import { captureSurfaceOracle } from "./native-surface-oracle.mjs";
import { captureTextExposureOracle } from "./native-text-exposure-oracle.mjs";
import { captureTextOracle } from "./native-text-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Component oracles supplement G1; native whole-project plan and pixel gates remain separate. */
export async function auditNativeSceneResources(context, projectInputs, execute = runStep, only) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const results = [];
  for (const spec of [
    {
      id: "project-frame",
      capture: captureProjectFrameOracle,
      test: "project_frame_oracle",
      name: "native_project_frames_match_ts",
      env: "ASTER_PROJECT_FRAME_ORACLE",
      corrupt: (value) => {
        value.cases[0].project.compositions[0].background[0] = 0.25;
      },
    },
    {
      id: "bundle",
      capture: captureBundleOracle,
      test: "bundle_oracle",
      name: "native_bundles_match_ts",
      env: "ASTER_BUNDLE_ORACLE",
      corrupt: (value) => {
        value.frames[0].expected.plan.blobs[0][0] ^= 1;
      },
    },
    {
      id: "auxiliary",
      capture: captureAuxiliaryOracle,
      test: "auxiliary_oracle",
      name: "native_auxiliary_matches_ts",
      env: "ASTER_AUXILIARY_ORACLE",
      corrupt: (value) => {
        value.cases
          .flatMap((c) => c.variants)
          .find((v) => v.expected.blobs[0].length > 8).expected.blobs[0][0] ^= 1;
      },
    },
    {
      id: "post-effect",
      capture: capturePostEffectOracle,
      test: "post_effect_oracle",
      name: "native_post_effects_match_ts",
      env: "ASTER_POST_EFFECT_ORACLE",
      corrupt: (value) => {
        value.depth[0].expected.blobs[0][0] ^= 1;
      },
    },
    {
      id: "text-exposure",
      capture: captureTextExposureOracle,
      test: "text_exposure_oracle",
      name: "native_text_exposure_matches_ts",
      env: "ASTER_TEXT_EXPOSURE_ORACLE",
      corrupt: (value) => {
        value.cases
          .flatMap((c) => c.samples)
          .find((s) => s.expected.sampleCount > 0).expected.sampleCount += 1;
      },
    },
    {
      id: "surface",
      capture: captureSurfaceOracle,
      test: "surface_oracle",
      name: "native_precomposition_sources_match_ts",
      env: "ASTER_SURFACE_ORACLE",
      corrupt: (value) => {
        value.cases
          .flatMap((c) => c.samples)
          .find((s) => s.expected?.operations.length).expected.operations[0].target.width += 1;
      },
    },
    {
      id: "effect-plan",
      capture: captureEffectPlanOracle,
      test: "effect_plan_oracle",
      name: "native_effect_plans_match_ts",
      env: "ASTER_EFFECT_PLAN_ORACLE",
      corrupt: (value) => {
        value.cases[0].expected.execution.blobs[0][0] += 1;
      },
    },
    {
      id: "plan",
      capture: capturePlanOracle,
      test: "plan_oracle",
      name: "native_plan_producers_match_ts",
      env: "ASTER_PLAN_ORACLE",
      corrupt: (value) => {
        value.cases.find((c) => c.expected).expected.scene.floats[0] += 100;
      },
    },
    {
      id: "generator",
      capture: captureGeneratorOracle,
      test: "generator_oracle",
      name: "native_generators_match_ts",
      env: "ASTER_GENERATOR_ORACLE",
      corrupt: (value) => {
        value.cases[0].expected.context[6] += 1;
      },
    },
    {
      id: "audio",
      capture: captureAudioOracle,
      test: "audio_oracle",
      name: "native_audio_matches_ts",
      env: "ASTER_AUDIO_ORACLE",
      corrupt: (value) => {
        value.frames[0].data[0] += 100;
      },
    },
    {
      id: "cloner",
      capture: captureClonerOracle,
      test: "cloner_oracle",
      name: "native_cloners_match_ts",
      env: "ASTER_CLONER_ORACLE",
      corrupt: (value) => {
        value.cases[0].samples[0].instances[0].position[0] += 100;
      },
    },
    {
      id: "effect-program",
      capture: captureEffectProgramOracle,
      test: "effect_program_oracle",
      name: "native_effect_programs_match_ts",
      env: "ASTER_EFFECT_PROGRAM_ORACLE",
      corrupt: (value) => {
        value.cases.find((c) => c.samples[0].bits.length).samples[0].bits[1] ^= 1;
      },
    },
    {
      id: "effect-input",
      capture: captureEffectInputOracle,
      test: "effect_input_oracle",
      name: "native_effect_inputs_match_ts",
      env: "ASTER_EFFECT_INPUT_ORACLE",
      corrupt: (value) => {
        value.cases[0].samples[0].values[0] += 100;
      },
    },
    {
      id: "text",
      capture: captureTextOracle,
      test: "text_oracle",
      name: "native_text_matches_ts",
      env: "ASTER_TEXT_ORACLE",
      corrupt: (value) => {
        const sample = value.cases.flatMap((c) => c.samples).find((s) => s.characters.length);
        assert(sample, "Text negative control requires a character");
        sample.characters[0].position[0] += 100;
      },
    },
    {
      id: "shape-graph",
      capture: captureShapeGraphOracle,
      test: "shape_graph_oracle",
      name: "native_shape_graphs_match_ts",
      env: "ASTER_SHAPE_GRAPH_ORACLE",
      corrupt: (value) => {
        const sample = value.cases
          .flatMap((item) => item.samples)
          .find((sample) => sample.shapes.length);
        assert(sample, "Shape graph negative control requires a visible instance");
        sample.shapes[0].instanceId = "wrong-shape-instance";
      },
    },
    {
      id: "camera",
      capture: captureCameraOracle,
      test: "camera_oracle",
      name: "native_camera_matches_ts",
      env: "ASTER_CAMERA_ORACLE",
      corrupt: (value) => {
        value.cases[0].samples[0].evaluated.projection.zoom += 100;
      },
    },
    {
      id: "lighting-mesh",
      capture: captureLightingMeshOracle,
      test: "lighting_mesh_oracle",
      name: "native_lighting_and_mesh_match_ts",
      env: "ASTER_LIGHTING_MESH_ORACLE",
      corrupt: (value) => {
        value.lighting[0].data[35] += 1;
      },
    },
  ]) {
    if (only && !only.includes(spec.id)) continue;
    const output = join(context.output, `${spec.id}-oracle.json`);
    const coverage = await spec.capture(context.root, output, projectInputs);
    const bytes = await reader.bytes(local(output));
    const oracle = JSON.parse(bytes.bytes);
    const steps = [];
    async function check(kind, path, accepted) {
      const step = await execute(
        {
          id: `native-${spec.id}-${kind}`,
          file: "cargo",
          args: [
            "test",
            "-p",
            "aster-eval",
            "--test",
            spec.test,
            spec.name,
            "--",
            "--ignored",
            "--exact",
          ],
        },
        { ...context, env: { ...context.env, [spec.env]: path } },
      );
      steps.push(step);
      assert(!step.error && !step.signal);
      assert.equal(step.status, accepted ? "passed" : "failed");
      assert.equal(step.exit_code, accepted ? 0 : 101);
      const log = (await reader.bytes(step.log)).bytes.toString("utf8");
      assert(
        accepted
          ? /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log)
          : /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log),
      );
    }
    await check("parity", output, true);
    for (const kind of [
      "wrong-value",
      "stale-source",
      ...(spec.id === "bundle"
        ? [
            "wrong-bundle-resource",
            "wrong-bundle-dependency",
            "wrong-bundle-mapping",
            "wrong-bundle-output",
          ]
        : []),
      ...(spec.id === "auxiliary"
        ? [
            "wrong-material-id",
            "wrong-auxiliary-route",
            "wrong-auxiliary-motion",
            "wrong-auxiliary-budget",
            "wrong-frame-output",
            "wrong-output-selection",
          ]
        : []),
      ...(spec.id === "surface"
        ? [
            "wrong-surface-budget",
            "wrong-surface-alias",
            "wrong-surface-order",
            "wrong-surface-graph",
            "wrong-surface-draw-index",
            "wrong-surface-effect-program",
            "wrong-surface-generator-origin",
          ]
        : []),
      ...(spec.id === "text-exposure"
        ? [
            "wrong-exposure-weight",
            "wrong-exposure-order",
            "wrong-exposure-bucket",
            "wrong-collation",
            "wrong-raster-weight",
            "wrong-raster-resource",
          ]
        : []),
      ...(spec.id === "post-effect"
        ? [
            "wrong-depth-state",
            "wrong-depth-input",
            "wrong-depth-camera",
            "wrong-surface-controls",
            "wrong-material-rotation",
            "wrong-material-reference",
          ]
        : []),
      ...(spec.id === "plan"
        ? [
            "wrong-root-order",
            "wrong-root-clear",
            "wrong-motion-vector",
            "wrong-shutter",
            "wrong-motion-uniform",
            "wrong-output-route",
            "wrong-project-effect",
            "wrong-project-material",
            "wrong-scene-media",
          ]
        : []),
      ...(spec.id === "effect-plan"
        ? [
            "wrong-effect-route",
            "wrong-effect-uniform",
            "wrong-lut",
            "wrong-effect-resource",
            "wrong-effect-record",
          ]
        : []),
      ...(spec.id === "generator"
        ? [
            "wrong-generator-parameters",
            "wrong-generator-dispatch",
            "wrong-generator-shader",
            "wrong-generator-plan",
            "wrong-generator-audio",
            "wrong-project-generator",
          ]
        : []),
      ...(spec.id === "audio" ? ["wrong-spectrum", "wrong-audio-history"] : []),
      ...(spec.id === "cloner" ? ["wrong-cloner-packing", "wrong-cloner-transform"] : []),
      ...(spec.id === "lighting-mesh" ? ["wrong-mesh-vertex"] : []),
      ...(spec.id === "text"
        ? ["wrong-selector", "wrong-cache-time", "wrong-travel", "wrong-expression"]
        : []),
      ...(spec.id === "effect-input" ? ["wrong-scaled-value", "wrong-gradient", "wrong-mask"] : []),
      ...(spec.id === "effect-program"
        ? ["wrong-opcode", "wrong-operation-order", "wrong-operation-count"]
        : []),
    ]) {
      const invalid = structuredClone(oracle);
      if (kind === "wrong-value") spec.corrupt(invalid);
      else if (kind === "wrong-bundle-resource")
        invalid.frames[0].resources.find((r) => r.bytes.length).bytes[0] ^= 1;
      else if (kind === "wrong-bundle-dependency") {
        const s = invalid.surfaces.find((s) =>
          s.resources.some((r) => r.message.kind === "media_source"),
        );
        s.resources = s.resources.filter((r) => r.message.kind !== "media_source");
      } else if (kind === "wrong-bundle-mapping")
        invalid.surfaces
          .flatMap((s) => s.scenes)
          .find((s) => s.draw_scene_indices.length).draw_scene_indices[0] = 65535;
      else if (kind === "wrong-bundle-output")
        invalid.frames[0].output.motion.metadata.header.project_revision += 1;
      else if (kind === "wrong-scene-media")
        invalid.cases.find(
          (c) => c.expected?.mediaBindings.length,
        ).expected.mediaBindings[0].draw_index = 65535;
      else if (kind === "wrong-project-material") {
        const c = invalid.cases.find((c) => c.bindings.material_resources.environment);
        c.bindings.material_resources.environment = "c".repeat(64);
      } else if (kind === "wrong-material-rotation")
        invalid.materials[0].settings.environmentRotation += 0.125;
      else if (kind === "wrong-material-reference")
        invalid.materials.find((c) => c.normal).normal = "c".repeat(64);
      else if (kind === "wrong-material-id")
        invalid.cases
          .flatMap((c) => c.variants)
          .find((v) => v.expected.blobs[0].length > 8).expected.blobs[0][4] ^= 1;
      else if (kind === "wrong-auxiliary-route")
        invalid.cases
          .flatMap((c) => c.variants)
          .flatMap((v) => v.expected.metadata.slices[0].draws)
          .find((d) => d.texture.kind === "surface").texture = { kind: "none" };
      else if (kind === "wrong-auxiliary-motion")
        invalid.cases
          .flatMap((c) => c.variants)
          .find((v) => v.motion?.length && v.expected.metadata.slices[0].motion).motion[0] += 1;
      else if (kind === "wrong-auxiliary-budget") invalid.budgets[0].expected = "drawn";
      else if (kind === "wrong-frame-output")
        invalid.cases[0].variants[0].outputs[0].expected.motion.blobs[0][0] ^= 1;
      else if (kind === "wrong-output-selection")
        invalid.cases
          .flatMap((c) => c.variants)
          .flatMap((v) => v.outputs)
          .find(
            (o) =>
              o.context.visualization === "selectionIsolation" &&
              o.context.selectedLayerId !== "missing-selection" &&
              o.expected.effect,
          ).context.selectedLayerId = "wrong-selected-instance";
      else if (kind === "wrong-depth-state")
        invalid.depth[0].expected.metadata.slices[0].status = "ready";
      else if (kind === "wrong-depth-input")
        invalid.depth[0].expected.metadata.slices[0].effect.inputs[0] = "motion_blur";
      else if (kind === "wrong-depth-camera")
        invalid.depth.find((c) => c.input.kind === "camera").settings.aperture += 1;
      else if (kind === "wrong-surface-controls") invalid.surface[0].expected.blobs[0][16] ^= 1;
      else if (kind === "wrong-project-generator") {
        const c = invalid.cases.at(-1);
        c.project.compositions
          .flatMap((c) => c.layers)
          .find((l) => l.id === c.layer.id).timeOffset += 1;
      } else if (kind === "wrong-surface-effect-program")
        invalid.cases
          .flatMap((c) => c.samples)
          .flatMap((s) => s.frame?.expected.frames ?? [])
          .find((f) => f.programs.effects.length).programs.effects[0].execution = "f".repeat(64);
      else if (kind === "wrong-surface-generator-origin")
        invalid.cases
          .flatMap((c) => c.samples)
          .flatMap((s) => s.frame?.expected.frames ?? [])
          .flatMap((f) => f.programs.generators)[0].origin.layerName += "wrong";
      else if (kind === "wrong-generator-shader")
        invalid.programSource.shaderSources[Object.keys(invalid.programSource.shaderSources)[0]] +=
          "\n// altered source";
      else if (kind === "wrong-generator-plan")
        invalid.cases[0].plan.metadata.header.project_revision += 1;
      else if (kind === "wrong-generator-audio") invalid.cases.find((c) => c.audio).audio[5] ^= 1;
      else if (kind === "wrong-raster-weight")
        invalid.rasterPasses.find(
          (c) => c.input.samples.length && !c.error,
        ).input.samples[0].weight *= 0.5;
      else if (kind === "wrong-raster-resource")
        invalid.rasterPasses.find((c) => !c.error).input.output = "f".repeat(64);
      else if (kind === "wrong-project-effect")
        invalid.cases.find(
          (c) => c.expected?.effects.records.length,
        ).expected.effects.records[0].execution = "f".repeat(64);
      else if (kind === "wrong-collation") invalid.collations[0].expected.reverse();
      else if (kind === "wrong-exposure-weight") {
        const plan = invalid.cases
          .flatMap((c) => c.samples)
          .flatMap((s) => Object.values(s.expected.plans))
          .find((p) => p.transparentWeight > 0);
        plan.transparentWeight += 0.1;
      } else if (kind === "wrong-exposure-order") {
        const sample = invalid.cases
          .flatMap((c) => c.samples)
          .find(
            (s) => s.expected.exposureSceneLayers.length && s.expected.renderSceneLayers.length > 1,
          );
        sample.expected.renderSceneLayers.reverse();
      } else if (kind === "wrong-exposure-bucket") {
        const slice = invalid.cases
          .flatMap((c) => c.samples)
          .flatMap((s) => Object.values(s.slices))
          .find((p) => p.blobs[0].length > 32);
        slice.blobs[0][32] ^= 1;
      } else if (kind === "wrong-surface-budget")
        invalid.cases
          .flatMap((c) => c.samples)
          .find((s) => s.expected?.operations.length).expected.budget.bytes += 1;
      else if (kind === "wrong-surface-alias") {
        const sample = invalid.cases
          .flatMap((c) => c.samples)
          .find((s) => Object.keys(s.expected?.bindings ?? {}).length);
        sample.expected.bindings[Object.keys(sample.expected.bindings)[0]] += "-wrong";
      } else if (kind === "wrong-surface-order") {
        const ops = invalid.cases
          .flatMap((c) => c.samples)
          .find((s) => s.expected?.operations.length >= 2).expected.operations;
        [ops[0], ops[1]] = [ops[1], ops[0]];
      } else if (kind === "wrong-surface-graph") {
        const frame = invalid.cases
          .flatMap((c) => c.samples)
          .find((s) => s.frame?.expected.graph.blobs[0].length > 16).frame;
        frame.expected.graph.blobs[0][16] ^= 1;
      } else if (kind === "wrong-surface-draw-index") {
        const frame = invalid.cases
          .flatMap((c) => c.samples)
          .flatMap((s) => s.frame?.expected.frames ?? [])
          .find((f) => f.draw_scene_indices.length);
        frame.draw_scene_indices[0] += 1;
      } else if (kind === "wrong-output-route")
        invalid.outputs[0].expected.metadata.slices[0].route = {
          kind: "beauty",
          source: "incorrect",
        };
      else if (kind === "wrong-motion-vector")
        invalid.cases.find((c) =>
          c.expected?.motion.vectors.some((v) => v !== 0),
        ).expected.motion.vectors[0] += 1;
      else if (kind === "wrong-shutter") invalid.shutters[0].interval.openTime += 1;
      else if (kind === "wrong-motion-uniform")
        invalid.cases.find((c) => c.expected).expected.motion.plan.blobs[0][8] ^= 1;
      else if (kind === "wrong-root-order") {
        const root = invalid.cases.find(
          (c) => c.expected?.root.metadata.slices[0].commands.length > 2,
        ).expected.root;
        root.metadata.slices[0].commands.reverse();
      } else if (kind === "wrong-root-clear")
        invalid.cases.find((c) => c.expected).expected.root.blobs[0][0] ^= 1;
      else if (kind === "wrong-effect-route")
        invalid.cases[0].expected.execution.metadata.slices[0].route = "incorrect";
      else if (kind === "wrong-effect-resource")
        invalid.cases[0].expected.bundle.resources[0].payload_sha256 = "0".repeat(64);
      else if (kind === "wrong-effect-record")
        invalid.cases[0].expected.bundle.records[0].execution = "0".repeat(64);
      else if (kind === "wrong-effect-uniform")
        invalid.cases.find((c) => c.expected.plan).expected.plan.blobs[0][0] ^= 1;
      else if (kind === "wrong-lut")
        invalid.cases.find((c) => c.expected.lut).expected.lut.bytes[0] ^= 1;
      else if (kind === "wrong-generator-parameters") invalid.cases[0].expected.parameters[0] ^= 1;
      else if (kind === "wrong-generator-dispatch") invalid.cases[0].expected.dispatches[0][0] += 1;
      else if (kind === "wrong-spectrum") invalid.spectra[0].data[1] += 1;
      else if (kind === "wrong-audio-history") invalid.frames.find((f) => f.present).data[140] += 1;
      else if (kind === "wrong-cloner-packing") invalid.cases[0].samples[0].data[12] += 1;
      else if (kind === "wrong-cloner-transform")
        invalid.cases[0].samples[0].composed[0].position[0] += 100;
      else if (kind === "wrong-opcode")
        invalid.cases.find((c) => c.samples[0].bits.length).samples[0].bits[0] ^= 1;
      else if (kind === "wrong-operation-order") {
        const sample = invalid.cases
          .flatMap((c) => c.samples)
          .find((s) => s.count >= 2 && s.bits[0] !== s.bits[16]);
        assert(sample, "Program negative control requires distinct ordered operations");
        const first = sample.bits.slice(0, 16);
        sample.bits.splice(0, 16, ...sample.bits.slice(16, 32));
        sample.bits.splice(16, 16, ...first);
      } else if (kind === "wrong-operation-count") invalid.cases[0].samples[0].count += 1;
      else if (kind === "wrong-mesh-vertex") invalid.meshes[0].samples[0].data[0] += 100;
      else if (kind === "wrong-scaled-value") invalid.cases[0].samples[0].scaledValues[0] += 100;
      else if (kind === "wrong-gradient")
        invalid.cases.find(
          (c) => c.effect.type === "multi-stop-gradient",
        ).samples[0].gradientColors[0] += 1;
      else if (kind === "wrong-mask")
        invalid.cases.find((c) => c.effect.mask).samples[0].mask[0] += 1;
      else if (kind === "wrong-selector") {
        const sample = invalid.cases
          .flatMap((c) => c.samples)
          .find((s) => s.selectors.some((g) => g.length));
        sample.selectors.find((g) => g.length)[0] += 1;
      } else if (kind === "wrong-cache-time") invalid.cases[0].samples[0].cacheTime = 987654;
      else if (kind === "wrong-travel") invalid.cases[0].samples[0].travel += 100;
      else if (kind === "wrong-expression") invalid.expressions[0].samples[0].fallback += 100;
      else invalid.sources[0].sha256 = "0".repeat(64);
      const path = join(context.output, `${spec.id}-${kind}.json`);
      await writeAtomicJson(path, invalid);
      await reader.bytes(local(path));
      await check(`reject-${kind}`, path, false);
    }
    results.push({
      id: spec.id,
      status: "passed",
      ...coverage,
      output: local(output),
      oracle_sha256: bytes.sha256,
      steps,
    });
  }
  if (only) assert.deepEqual(results.map((r) => r.id).sort(), [...only].sort());
  return {
    status: "passed",
    scope: only
      ? "selected-component-diagnostic"
      : "camera-lighting-material-mesh-shape-graph-text-effect-cloner-generator-audio-components",
    whole_project_plan_parity: false,
    components: results,
    checked_files: await reader.stable(),
  };
}
