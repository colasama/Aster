import type { FlattenedSceneLayer } from "../core/scene-evaluation";
import type { Composition, Layer } from "../core/types";

export const FLOATS_PER_VERTEX = 9;

export interface GeometryBatch {
  layer: Layer;
  instanceId: string;
  firstVertex: number;
  vertexCount: number;
}

export interface GeometryResult {
  data: Float32Array;
  batches: GeometryBatch[];
}

const QUAD_CORNERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-0.5, -0.5, 0, 0],
  [0.5, -0.5, 1, 0],
  [-0.5, 0.5, 0, 1],
  [-0.5, 0.5, 0, 1],
  [0.5, -0.5, 1, 0],
  [0.5, 0.5, 1, 1],
];

export function buildSceneGeometry(
  composition: Composition,
  sceneLayers: FlattenedSceneLayer[],
): GeometryResult {
  const output: number[] = [];
  const batches: GeometryBatch[] = [];
  const visible = sceneLayers.filter(
    (scene) =>
      scene.layer.kind !== "particle" &&
      scene.layer.kind !== "camera" &&
      scene.layer.kind !== "light",
  );
  for (const scene of visible.reverse()) {
    const { layer, transform } = scene;
    const firstVertex = output.length / FLOATS_PER_VERTEX;
    const shade = layer.threeDimensional
      ? 0.72 +
        0.28 *
          Math.max(
            0,
            Math.cos(toRadians(transform.rotation[0])) * Math.cos(toRadians(transform.rotation[1])),
          )
      : 1;
    const color = [
      Math.min(4, layer.color[0] * shade),
      Math.min(4, layer.color[1] * shade),
      Math.min(4, layer.color[2] * shade),
      layer.color[3] * transform.opacity,
    ] as const;
    const width = (layer.size[0] * transform.scale[0]) / 100;
    const height = (layer.size[1] * transform.scale[1]) / 100;
    const mediaType =
      layer.kind === "video"
        ? 2
        : layer.kind === "shape" &&
            layer.size[0] === layer.size[1] &&
            layer.size[0] < composition.width
          ? 1
          : 0;
    for (const [cornerX, cornerY, u, v] of QUAD_CORNERS) {
      const [x, y] = projectVertex(
        cornerX * width,
        cornerY * height,
        layer.threeDimensional,
        transform.position,
        transform.rotation,
        composition,
      );
      output.push(
        (x / composition.width) * 2 - 1,
        1 - (y / composition.height) * 2,
        u,
        v,
        ...color,
        mediaType,
      );
    }
    batches.push({
      layer,
      instanceId: scene.instanceId,
      firstVertex,
      vertexCount: QUAD_CORNERS.length,
    });
  }
  return { data: new Float32Array(output), batches };
}

function projectVertex(
  localX: number,
  localY: number,
  threeDimensional: boolean,
  position: [number, number, number],
  rotation: [number, number, number],
  composition: Composition,
): [number, number] {
  if (!threeDimensional) {
    const angle = toRadians(rotation[2]);
    return [
      position[0] + localX * Math.cos(angle) - localY * Math.sin(angle),
      position[1] + localX * Math.sin(angle) + localY * Math.cos(angle),
    ];
  }
  let x = localX;
  let y = localY;
  let z = 0;
  const rotationX = toRadians(rotation[0]);
  const rotationY = toRadians(rotation[1]);
  const rotationZ = toRadians(rotation[2]);
  [y, z] = [
    y * Math.cos(rotationX) - z * Math.sin(rotationX),
    y * Math.sin(rotationX) + z * Math.cos(rotationX),
  ];
  [x, z] = [
    x * Math.cos(rotationY) + z * Math.sin(rotationY),
    -x * Math.sin(rotationY) + z * Math.cos(rotationY),
  ];
  [x, y] = [
    x * Math.cos(rotationZ) - y * Math.sin(rotationZ),
    x * Math.sin(rotationZ) + y * Math.cos(rotationZ),
  ];
  const worldX = position[0] + x;
  const worldY = position[1] + y;
  const worldZ = position[2] + z;
  const focalLength = Math.max(composition.width, composition.height) * 1.2;
  const perspective = focalLength / Math.max(focalLength * 0.12, focalLength - worldZ);
  return [
    composition.width / 2 + (worldX - composition.width / 2) * perspective,
    composition.height / 2 + (worldY - composition.height / 2) * perspective,
  ];
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
