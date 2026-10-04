import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { buildSceneGeometry } from "../geometry/geometry";
import { evaluateSceneCamera } from "../scene/scene-camera";
import { buildSceneLighting } from "../scene/scene-lighting";
import { buildTimeAddressedMotionVectors } from "../scene/time-addressed-motion-vectors";
import { encodeFramePlan } from "./codec";
import { buildSceneBufferPlan, type SceneBufferPlanInput } from "./scene-buffer-plan";

export function sceneBufferFixtureInput(empty = false): SceneBufferPlanInput {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.id = "scene-wire-root";
  const nested = {
    ...structuredClone(composition),
    id: "scene-wire-nested",
    layers: [] as typeof composition.layers,
  };
  const shape = createLayerForComposition("shape", nested);
  shape.id = "shape\0\ud800";
  shape.threeDimensional = true;
  shape.transform.position[0] = {
    mode: "animated",
    keyframes: [
      { id: "a", time: 0, value: 100, interpolation: "linear" },
      { id: "b", time: 2, value: 400, interpolation: "linear" },
    ],
  };
  nested.layers = [shape];
  project.compositions.push(nested);
  const wrapper = createLayerForComposition("precomposition", composition);
  wrapper.id = "nested-instance";
  wrapper.sourceCompositionId = nested.id;
  const mesh = createLayerForComposition("mesh", composition);
  mesh.id = "mesh-instance";
  mesh.threeDimensional = true;
  const vector = createLayerForComposition("shape", composition);
  vector.id = "flat-vector";
  const camera = createLayerForComposition("camera", composition);
  camera.id = "camera";
  const light = createLayerForComposition("light", composition);
  light.id = "light";
  composition.layers = empty ? [] : [wrapper, mesh, vector, camera, light];
  const evaluate = (time: number) =>
    buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, time),
      evaluateSceneCamera(composition, time),
    );
  const geometry = evaluate(1);
  return {
    snapshot: { snapshotScope: "scene-buffer-fixture", projectRevision: 42 },
    compositionId: composition.id,
    time: 1,
    frameRate: composition.frameRate,
    target: { width: composition.width, height: composition.height },
    renderTarget: { width: composition.width, height: composition.height },
    antiAliasing: "off",
    geometry,
    lighting: buildSceneLighting(
      flattenSceneLayers(composition, project, 1),
      composition,
      true,
      evaluateSceneCamera(composition, 1)?.pose.position,
    ),
    motionVectors: buildTimeAddressedMotionVectors(geometry, evaluate(0.9), evaluate(1.1)),
    shadowsEnabled: true,
  };
}

export function sceneBufferFixtures(): { id: string; bytes: Uint8Array }[] {
  return [false, true].map((empty) => {
    const input = sceneBufferFixtureInput(empty);
    const plan = buildSceneBufferPlan(input);
    return {
      id: empty ? "scene-empty" : "scene-nested-mesh-camera",
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
    };
  });
}
