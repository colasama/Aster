import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { staticValue } from "../../core/types";
import { evaluateSceneCamera } from "../scene/scene-camera";
import { buildCameraPlan } from "./camera-plan";
import { encodeFramePlan } from "./codec";
import type { RootPostUniformPlanInput } from "./root-post-plan";

export function cameraFixture(kind: "perspective" | "orthographic") {
  const project = createBlankProject();
  const root = project.compositions[0];
  root.id = "camera-fixture-root";
  const composition = { ...structuredClone(root), id: "nested-camera", width: 640, height: 360 };
  const layer = createLayerForComposition("camera", composition);
  layer.id = "animated-camera";
  if (!layer.camera) throw new Error("Camera fixture requires settings");
  layer.camera.projection = kind;
  layer.camera.mode = kind === "perspective" ? "twoNode" : "oneNode";
  layer.camera.depthOfField = true;
  layer.camera.irisShape = kind === "perspective" ? "hexagon" : "fastRectangle";
  layer.camera.lockFocusToZoom = false;
  layer.camera.focusDistance = staticValue(411.25);
  layer.camera.zoom = staticValue(815.123456789);
  layer.camera.irisRotation = staticValue(17.25);
  layer.transform.position[0] = {
    mode: "animated",
    keyframes: [
      { id: "start", time: 0, value: 100.125, interpolation: "linear" },
      { id: "end", time: 4, value: 410.75, interpolation: "linear" },
    ],
  };
  const mesh = createLayerForComposition("mesh", composition);
  mesh.id = "camera-mesh";
  mesh.threeDimensional = true;
  const vector = createLayerForComposition("shape", composition);
  vector.id = "camera-vector";
  vector.threeDimensional = true;
  composition.layers = [mesh, vector, layer];
  const wrapper = createLayerForComposition("precomposition", root);
  wrapper.id = "camera-wrapper";
  wrapper.sourceCompositionId = composition.id;
  wrapper.inPoint = 0.5;
  root.layers = [wrapper];
  project.compositions.push(composition);
  const surface = flattenSceneLayers(root, project, 1).find(
    (scene) => scene.precompositionSurface,
  )?.precompositionSurface;
  if (!surface) throw new Error("Nested camera fixture requires a surface");
  const camera = evaluateSceneCamera(composition, surface.time);
  if (!camera) throw new Error("Expected evaluated camera");
  const header: RootPostUniformPlanInput = {
    snapshot: { snapshotScope: "camera-fixture", projectRevision: 7 },
    compositionId: composition.id,
    time: surface.time,
    frameRate: composition.frameRate,
    target: { width: composition.width, height: composition.height },
    renderTarget: { width: composition.width, height: composition.height },
    antiAliasing: "off",
  };
  return {
    header,
    camera,
    project,
    composition,
    layer,
    sceneLayers: flattenSceneLayers(composition, project, surface.time),
  };
}

export function cameraPlanFixtures() {
  return (["perspective", "orthographic"] as const).map((kind) => {
    const { header, camera } = cameraFixture(kind);
    const plan = buildCameraPlan(header, camera);
    return { id: `camera-${kind}`, bytes: encodeFramePlan(plan.metadata, plan.blobs), camera };
  });
}
