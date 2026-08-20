import type { FlattenedSceneLayer } from "../core/scene-evaluation";
import type { Composition, EvaluatedTransform, Layer } from "../core/types";

export const FLOATS_PER_VERTEX = 20;
export const VERTEX_FLOAT_OFFSETS = {
  position: 0,
  uv: 3,
  color: 5,
  mediaType: 9,
  normal: 10,
  material: 13,
  worldPosition: 17,
} as const;

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

const CUBE_FACES: ReadonlyArray<{
  normal: readonly [number, number, number];
  corners: ReadonlyArray<readonly [number, number, number, number, number]>;
}> = [
  {
    normal: [0, 0, 1],
    corners: face([-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]),
  },
  {
    normal: [0, 0, -1],
    corners: face([0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]),
  },
  {
    normal: [1, 0, 0],
    corners: face([0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]),
  },
  {
    normal: [-1, 0, 0],
    corners: face([-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]),
  },
  {
    normal: [0, -1, 0],
    corners: face([-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5]),
  },
  {
    normal: [0, 1, 0],
    corners: face([-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]),
  },
];

export function buildSceneGeometry(
  composition: Composition,
  sceneLayers: FlattenedSceneLayer[],
  camera?: EvaluatedTransform,
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
    const color = [
      Math.min(4, layer.color[0]),
      Math.min(4, layer.color[1]),
      Math.min(4, layer.color[2]),
      layer.color[3] * transform.opacity,
    ] as const;
    const material = [
      layer.material?.metallic ?? 0.12,
      layer.material?.roughness ?? 0.48,
      layer.material?.emissive ?? 0,
      Number(layer.threeDimensional || layer.kind === "mesh"),
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
    if (layer.kind === "mesh") {
      const depth = Math.min(width, height) * 0.68;
      for (const cubeFace of CUBE_FACES) {
        const normal = rotatePoint(...cubeFace.normal, transform.rotation);
        for (const [cornerX, cornerY, cornerZ, u, v] of cubeFace.corners) {
          const projected = projectVertex(
            cornerX * width,
            cornerY * height,
            cornerZ * depth,
            true,
            transform.position,
            transform.rotation,
            composition,
            camera,
          );
          pushVertex(output, projected, u, v, color, 0, normal, material, composition);
        }
      }
    } else {
      const normal = rotatePoint(0, 0, 1, transform.rotation);
      for (const [cornerX, cornerY, u, v] of QUAD_CORNERS) {
        const projected = projectVertex(
          cornerX * width,
          cornerY * height,
          0,
          layer.threeDimensional,
          transform.position,
          transform.rotation,
          composition,
          camera,
        );
        pushVertex(output, projected, u, v, color, mediaType, normal, material, composition);
      }
    }
    batches.push({
      layer,
      instanceId: scene.instanceId,
      firstVertex,
      vertexCount: layer.kind === "mesh" ? CUBE_FACES.length * 6 : QUAD_CORNERS.length,
    });
  }
  return { data: new Float32Array(output), batches };
}

function projectVertex(
  localX: number,
  localY: number,
  localZ: number,
  threeDimensional: boolean,
  position: [number, number, number],
  rotation: [number, number, number],
  composition: Composition,
  camera?: EvaluatedTransform,
): { clip: [number, number, number]; world: [number, number, number] } {
  if (!threeDimensional) {
    const angle = toRadians(rotation[2]);
    const world: [number, number, number] = [
      position[0] + localX * Math.cos(angle) - localY * Math.sin(angle),
      position[1] + localX * Math.sin(angle) + localY * Math.cos(angle),
      position[2] + localZ,
    ];
    return { clip: [world[0], world[1], 1], world };
  }
  const [x, y, z] = rotatePoint(localX, localY, localZ, rotation);
  const world: [number, number, number] = [position[0] + x, position[1] + y, position[2] + z];
  const cameraPosition = camera?.position ?? [composition.width / 2, composition.height / 2, 0];
  const relative: [number, number, number] = [
    world[0] - cameraPosition[0],
    world[1] - cameraPosition[1],
    world[2] - cameraPosition[2],
  ];
  const [viewX, viewY, viewZ] = applyInverseRotation(relative, camera?.rotation ?? [0, 0, 0]);
  const focalLength = Math.max(composition.width, composition.height) * 1.2;
  const perspective = focalLength / Math.max(focalLength * 0.08, focalLength - viewZ);
  return {
    clip: [
      composition.width / 2 + viewX * perspective,
      composition.height / 2 + viewY * perspective,
      Math.max(0, Math.min(1, 0.5 - viewZ / (focalLength * 2))),
    ],
    world,
  };
}

function pushVertex(
  output: number[],
  projected: { clip: [number, number, number]; world: [number, number, number] },
  u: number,
  v: number,
  color: readonly [number, number, number, number],
  mediaType: number,
  normal: readonly [number, number, number],
  material: readonly [number, number, number, number],
  composition: Composition,
): void {
  output.push(
    (projected.clip[0] / composition.width) * 2 - 1,
    1 - (projected.clip[1] / composition.height) * 2,
    projected.clip[2],
    u,
    v,
    ...color,
    mediaType,
    ...normal,
    ...material,
    ...projected.world,
  );
}

function face(
  topLeft: readonly [number, number, number],
  topRight: readonly [number, number, number],
  bottomLeft: readonly [number, number, number],
  bottomRight: readonly [number, number, number],
): ReadonlyArray<readonly [number, number, number, number, number]> {
  return [
    [...topLeft, 0, 0],
    [...topRight, 1, 0],
    [...bottomLeft, 0, 1],
    [...bottomLeft, 0, 1],
    [...topRight, 1, 0],
    [...bottomRight, 1, 1],
  ];
}

function rotatePoint(
  sourceX: number,
  sourceY: number,
  sourceZ: number,
  rotation: [number, number, number],
): [number, number, number] {
  let x = sourceX;
  let y = sourceY;
  let z = sourceZ;
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
  return [x, y, z];
}

function applyInverseRotation(
  source: [number, number, number],
  rotation: [number, number, number],
): [number, number, number] {
  let [x, y, z] = source;
  const rotationZ = -toRadians(rotation[2]);
  const rotationY = -toRadians(rotation[1]);
  const rotationX = -toRadians(rotation[0]);
  [x, y] = [
    x * Math.cos(rotationZ) - y * Math.sin(rotationZ),
    x * Math.sin(rotationZ) + y * Math.cos(rotationZ),
  ];
  [x, z] = [
    x * Math.cos(rotationY) + z * Math.sin(rotationY),
    -x * Math.sin(rotationY) + z * Math.cos(rotationY),
  ];
  [y, z] = [
    y * Math.cos(rotationX) - z * Math.sin(rotationX),
    y * Math.sin(rotationX) + z * Math.cos(rotationX),
  ];
  return [x, y, z];
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
