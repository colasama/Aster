import {
  createTransform,
  type Layer,
  setLayerSizeAndCenterAnchor,
  staticValue,
} from "../../../src/core/types";
import type { GeneratedCase } from "../types";
import { caseFor, fixture } from "./base";
import { motion, rectangle } from "./scene-shared";

export function buildSpatialCases(): GeneratedCase[] {
  return [
    cameraScene(false, 50),
    cameraScene(true, 50),
    ...[15, 55, 95].map((quality) => cameraScene(false, quality, true)),
    ...(["directional", "point", "spot"] as const).map(lightingScene),
  ];
}

function cameraScene(orthographic: boolean, quality: number, depthOfField = false): GeneratedCase {
  const id = depthOfField
    ? `scene-dof-${quality}`
    : `scene-camera-${orthographic ? "orthographic" : "perspective"}`;
  const scene = fixture(id);
  const camera = scene.layer("camera", "Moving scene camera");
  if (!camera.camera) throw new Error("Camera fixture requires complete camera settings");
  camera.camera.projection = orthographic ? "orthographic" : "perspective";
  camera.camera.depthOfField = depthOfField;
  camera.camera.lockFocusToZoom = false;
  camera.camera.focusDistance = motion(400, 520);
  camera.camera.aperture = staticValue(60);
  camera.camera.irisShape = "hexagon";
  camera.camera.irisRoundness = staticValue(20);
  camera.camera.renderQuality = quality;
  camera.transform.position[0] = motion(140, 180);
  const cards = [-90, 0, 140].map((z, index) => {
    const card = rectangle(
      scene,
      `Depth card ${index}`,
      [72 + index * 88, 90, z],
      [48, 84],
      [
        [0.9, 0.12, 0.04, 1],
        [0.08, 0.8, 0.3, 1],
        [0.1, 0.3, 1.8, 1],
      ][index] as Layer["color"],
    );
    card.threeDimensional = true;
    card.transform.rotation[1] = staticValue(index * 12 - 12);
    if (card.shape) {
      card.shape.strokeWidth = 3;
      card.shape.strokeColor = [1, 1, 1, 1];
    }
    return card;
  });
  scene.composition.layers = [camera, ...cards];
  return caseFor(id, scene.project, [
    "layer:camera",
    "layer:shape",
    "feature:camera",
    ...(depthOfField ? ["feature:depth-of-field"] : []),
  ]);
}

function lightingScene(kind: NonNullable<Layer["light"]>["kind"]): GeneratedCase {
  const id = `scene-lighting-${kind}`;
  const scene = fixture(id);
  const mesh = scene.layer("mesh", "Rotating material cube");
  setLayerSizeAndCenterAnchor(mesh, [82, 82]);
  mesh.transform = createTransform([120, 83, -20], [41, 41, 0]);
  mesh.transform.rotation = [staticValue(-18), motion(-30, 45), staticValue(10)];
  mesh.color = [0.4, 0.22, 0.85, 1];
  mesh.material = {
    metallic: 0.65,
    roughness: 0.28,
    emissive: 0.05,
    alphaMode: "opaque",
    alphaCutoff: 0.5,
  };
  const imported = scene.layer("mesh", "Inline indexed pyramid");
  setLayerSizeAndCenterAnchor(imported, [72, 72]);
  imported.transform = createTransform([235, 99, 30], [36, 36, 0]);
  imported.transform.rotation[1] = motion(35, -35);
  imported.color = [0.95, 0.55, 0.08, 1];
  imported.mesh = pyramid();
  const receiver = scene.layer("mesh", "Lit shadow receiver");
  setLayerSizeAndCenterAnchor(receiver, [295, 155]);
  receiver.transform = createTransform([160, 110, 95], [147.5, 77.5, 0]);
  receiver.color = [0.45, 0.5, 0.55, 1];
  receiver.material = {
    metallic: 0,
    roughness: 0.85,
    emissive: 0,
    alphaMode: "opaque",
    alphaCutoff: 0.5,
  };
  receiver.mesh = {
    name: "Receiver plane",
    positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0],
    normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1],
    uvs: [0, 0, 1, 0, 0, 1, 1, 1],
    indices: [0, 2, 1, 1, 2, 3],
  };
  const light = scene.layer("light", `${kind} shadow light`);
  light.transform = createTransform([80, 30, -180]);
  light.transform.rotation = [staticValue(20), staticValue(-20), staticValue(0)];
  light.light = { kind, intensity: 3, range: 750, coneAngle: 70, shadowQuality: "medium" };
  scene.composition.environment = {
    enabled: true,
    intensity: 0.45,
    rotation: 20,
    source: {
      name: "Deterministic 4 by 2 RGBE environment",
      mimeType: "image/vnd.radiance",
      dataUrl:
        "data:image/vnd.radiance;base64,Iz9SQURJQU5DRQpGT1JNQVQ9MzItYml0X3JsZV9yZ2JlCgotWSAyICtYIDQK3LR4gqDI/4JkjNyCtHhQgig8ZIFGWoyBeFAygTJGboE=",
    },
  };
  scene.composition.layers = [scene.layer("camera"), light, imported, mesh, receiver];
  return caseFor(id, scene.project, [
    "layer:light",
    "layer:mesh",
    "layer:camera",
    "feature:lights",
    ...(kind === "point" ? [] : ["feature:shadows"]),
    "feature:meshes",
    "feature:hdr-environment",
  ]);
}

function pyramid(): NonNullable<Layer["mesh"]> {
  const points = [
    [-0.5, 0.5, -0.5],
    [0.5, 0.5, -0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
    [0, -0.5, 0],
  ];
  const faces = [
    [0, 4, 1],
    [1, 4, 2],
    [2, 4, 3],
    [3, 4, 0],
    [0, 1, 2],
    [0, 2, 3],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const [a, b, c] = face.map((index) => points[index]);
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...cross);
    for (const point of [a, b, c]) {
      indices.push(indices.length);
      positions.push(...point);
      normals.push(...cross.map((value) => value / length));
      uvs.push(point[0] + 0.5, point[1] + 0.5);
    }
  }
  return { name: "Six-face indexed pyramid", positions, normals, uvs, indices };
}
