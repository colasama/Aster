import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { Composition } from "../../core/types";

export const MAX_SCENE_LIGHTS = 8;
export const SCENE_LIGHTING_BYTES =
  (36 + (MAX_SCENE_LIGHTS - 1) * 16) * Float32Array.BYTES_PER_ELEMENT;

export function shadowMapSize(quality: "off" | "low" | "medium" | "high"): number {
  if (quality === "off") return 1;
  if (quality === "low") return 512;
  if (quality === "high") return 2048;
  return 1024;
}

export function buildSceneLighting(
  sceneLayers: FlattenedSceneLayer[],
  composition: Composition,
  shadowsAvailable = true,
  cameraPosition: readonly [number, number, number] = [
    composition.width / 2,
    composition.height / 2,
    0,
  ],
): Float32Array {
  const lights: FlattenedSceneLayer[] = [];
  for (const scene of sceneLayers) {
    if (scene.layer.kind === "light") lights.push(scene);
    if (lights.length === MAX_SCENE_LIGHTS) break;
  }
  const light = lights[0];
  const direction = light
    ? rotateDirection([0, 0, 1], light.transform.rotation)
    : ([0.35, -0.45, 0.82] as [number, number, number]);
  const length = Math.hypot(...direction) || 1;
  const normalized = direction.map((component) => component / length) as [number, number, number];
  const kind = light?.layer.light?.kind ?? "directional";
  const shadow = buildShadowProjection(normalized, composition);
  const uniforms = new Float32Array(SCENE_LIGHTING_BYTES / Float32Array.BYTES_PER_ELEMENT);
  uniforms.set([
    ...normalized,
    light?.layer.light?.intensity ?? 1.25,
    ...(light?.layer.color.slice(0, 3) ?? [1, 0.96, 0.9]),
    light ? 0.12 : 0.16,
    ...(light?.transform.position ?? [0, 0, 0]),
    kind === "directional" ? 0 : kind === "point" ? 1 : 2,
    light?.layer.light?.range ?? 10_000,
    Math.cos(((light?.layer.light?.coneAngle ?? 45) * Math.PI) / 360),
    (light?.layer.light?.shadowQuality ?? "medium") === "off" || !shadowsAvailable ? 0 : 1,
    0,
    ...shadow,
    ...cameraPosition,
    Math.max(0, lights.length - 1),
  ]);
  for (let index = 1; index < lights.length; index++) {
    const additional = lights[index];
    const settings = additional.layer.light;
    uniforms.set(
      [
        ...normalize(rotateDirection([0, 0, 1], additional.transform.rotation)),
        settings?.intensity ?? 1.25,
        ...additional.layer.color.slice(0, 3),
        0,
        ...additional.transform.position,
        settings?.kind === "point" ? 1 : settings?.kind === "spot" ? 2 : 0,
        settings?.range ?? 10_000,
        Math.cos(((settings?.coneAngle ?? 45) * Math.PI) / 360),
        0,
        0,
      ],
      36 + (index - 1) * 16,
    );
  }
  return uniforms;
}

function buildShadowProjection(
  direction: [number, number, number],
  composition: Composition,
): number[] {
  const up: [number, number, number] = Math.abs(direction[1]) < 0.96 ? [0, 1, 0] : [1, 0, 0];
  const basisX = normalize(cross(up, direction));
  const basisY = normalize(cross(direction, basisX));
  const span = Math.max(composition.width, composition.height) * 1.6;
  const depthSpan = span * 2;
  return [
    ...basisX,
    2 / span,
    ...basisY,
    2 / span,
    ...direction,
    1 / depthSpan,
    composition.width / 2,
    composition.height / 2,
    0,
    0.0025,
  ];
}

function cross(
  left: [number, number, number],
  right: [number, number, number],
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector) || 1;
  return vector.map((component) => component / length) as [number, number, number];
}

function rotateDirection(
  direction: [number, number, number],
  rotation: [number, number, number],
): [number, number, number] {
  let [x, y, z] = direction;
  const [rx, ry, rz] = rotation.map((degrees) => (degrees * Math.PI) / 180);
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x, y, z];
}
