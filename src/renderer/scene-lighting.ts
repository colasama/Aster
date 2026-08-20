import type { FlattenedSceneLayer } from "../core/scene-evaluation";
import type { Composition } from "../core/types";

export const SCENE_LIGHTING_BYTES = 32 * Float32Array.BYTES_PER_ELEMENT;

export function shadowMapSize(quality: "off" | "low" | "medium" | "high"): number {
  if (quality === "off") return 1;
  if (quality === "low") return 512;
  if (quality === "high") return 2048;
  return 1024;
}

export function buildSceneLighting(
  sceneLayers: FlattenedSceneLayer[],
  composition: Composition,
): Float32Array {
  const light = sceneLayers.find((scene) => scene.layer.kind === "light");
  const direction = light
    ? rotateDirection([0, 0, 1], light.transform.rotation)
    : ([0.35, -0.45, 0.82] as [number, number, number]);
  const length = Math.hypot(...direction) || 1;
  const normalized = direction.map((component) => component / length) as [number, number, number];
  const kind = light?.layer.light?.kind ?? "directional";
  const shadow = buildShadowProjection(normalized, composition);
  return new Float32Array([
    ...normalized,
    light?.layer.light?.intensity ?? 1.25,
    ...(light?.layer.color.slice(0, 3) ?? [1, 0.96, 0.9]),
    light ? 0.12 : 0.16,
    ...(light?.transform.position ?? [0, 0, 0]),
    kind === "directional" ? 0 : kind === "point" ? 1 : 2,
    light?.layer.light?.range ?? 10_000,
    Math.cos(((light?.layer.light?.coneAngle ?? 45) * Math.PI) / 360),
    (light?.layer.light?.shadowQuality ?? "medium") === "off" ? 0 : 1,
    0,
    ...shadow,
  ]);
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
