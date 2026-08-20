import type { FlattenedSceneLayer } from "../core/scene-evaluation";

export const SCENE_LIGHTING_BYTES = 16 * Float32Array.BYTES_PER_ELEMENT;

export function buildSceneLighting(sceneLayers: FlattenedSceneLayer[]): Float32Array {
  const light = sceneLayers.find((scene) => scene.layer.kind === "light");
  if (!light)
    return new Float32Array([
      0.35, -0.45, 0.82, 1.25, 1, 0.96, 0.9, 0.16, 0, 0, 0, 0, 10_000, 0, 0, 0,
    ]);
  const direction = rotateDirection([0, 0, 1], light.transform.rotation);
  const length = Math.hypot(...direction) || 1;
  const kind = light.layer.light?.kind ?? "directional";
  return new Float32Array([
    direction[0] / length,
    direction[1] / length,
    direction[2] / length,
    light.layer.light?.intensity ?? 2.5,
    light.layer.color[0],
    light.layer.color[1],
    light.layer.color[2],
    0.12,
    light.transform.position[0],
    light.transform.position[1],
    light.transform.position[2],
    kind === "directional" ? 0 : kind === "point" ? 1 : 2,
    light.layer.light?.range ?? 2400,
    Math.cos(((light.layer.light?.coneAngle ?? 45) * Math.PI) / 360),
    0,
    0,
  ]);
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
