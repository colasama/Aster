import type { FlattenedSceneLayer } from "../core/scene-evaluation";
import { solidRenderColor, solidRenderSize } from "../core/solid-layer";
import type { CameraSettings, Composition, EvaluatedTransform, Layer } from "../core/types";
import {
  flattenBezierPath,
  tessellateStroke,
  triangulatePolygon,
  trimPolyline,
} from "./vector-path";

export const FLOATS_PER_VERTEX = 40;
export const VERTEX_FLOAT_OFFSETS = {
  position: 0,
  uv: 3,
  color: 5,
  mediaType: 9,
  normal: 10,
  material: 13,
  worldPosition: 17,
  shapeStyleColor: 20,
  shapeStyleParameters: 24,
  gradientStyleColor: 28,
  gradientStyleParameters: 32,
  tangent: 36,
} as const;

export interface GeometryBatch {
  layer: Layer;
  instanceId: string;
  resourceInstanceId: string;
  selectionId: string;
  firstVertex: number;
  vertexCount: number;
}

export interface GeometryResult {
  data: Float32Array;
  batches: GeometryBatch[];
}

export interface SceneCamera {
  transform: EvaluatedTransform;
  settings: CameraSettings;
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
  camera?: SceneCamera,
): GeometryResult {
  const output: number[] = [];
  const batches: GeometryBatch[] = [];
  const visible = sceneLayers.filter(
    (scene) =>
      scene.layer.kind !== "generator" &&
      scene.layer.kind !== "adjustment" &&
      scene.layer.kind !== "null" &&
      scene.layer.kind !== "camera" &&
      scene.layer.kind !== "light",
  );
  for (const scene of visible.reverse()) {
    const { layer, transform } = scene;
    const firstVertex = output.length / FLOATS_PER_VERTEX;
    const resolvedColor = solidRenderColor(layer);
    const color = [
      layer.kind === "text" ? 1 : Math.min(4, resolvedColor[0]),
      layer.kind === "text" ? 1 : Math.min(4, resolvedColor[1]),
      layer.kind === "text" ? 1 : Math.min(4, resolvedColor[2]),
      resolvedColor[3] * transform.opacity,
    ] as const;
    const layerMaterial = layer.material ?? layer.mesh?.sourceMaterial;
    const material = [
      layerMaterial?.metallic ?? 0.12,
      layerMaterial?.roughness ?? 0.48,
      layerMaterial?.emissive ?? 0,
      Number(layer.threeDimensional || layer.kind === "mesh"),
    ] as const;
    const sourceSize = scene.precompositionSurface
      ? [
          scene.precompositionSurface.composition.width,
          scene.precompositionSurface.composition.height,
        ]
      : solidRenderSize(layer);
    const width = (sourceSize[0] * transform.scale[0]) / 100;
    const height = (sourceSize[1] * transform.scale[1]) / 100;
    const mediaType = layer.kind === "video" ? 2 : 0;
    const inferredShapeKind =
      layer.shape?.kind ??
      (layer.kind === "shape" && layer.size[0] === layer.size[1] ? "ellipse" : "rectangle");
    const minimumDimension = Math.max(1, Math.min(Math.abs(width), Math.abs(height)));
    const shapeStyleColor =
      layer.kind === "mesh"
        ? ([1, 1, 1, layer.mesh?.baseColor?.[3] ?? 1] as const)
        : (layer.shape?.strokeColor ?? ([1, 1, 1, 1] as const));
    const shapeStyleParameters = [
      layer.kind === "shape" ? ((layer.shape?.strokeWidth ?? 0) / minimumDimension) * 2 : 0,
      layer.kind === "shape" ? Math.min(0.49, (layer.shape?.roundness ?? 0) / minimumDimension) : 0,
      layer.kind === "shape"
        ? inferredShapeKind === "ellipse"
          ? 2
          : inferredShapeKind === "line"
            ? 3
            : inferredShapeKind === "bezier"
              ? 4
              : 1
        : 0,
      layer.shape?.lineCap === "round" ? 1 : 0,
    ] as const;
    const gradientStyleColor = layer.shape?.gradientColor ?? ([0, 0, 0, 1] as const);
    const gradientStyleParameters = [
      layer.kind === "mesh"
        ? layerMaterial?.alphaMode === "mask"
          ? 1
          : layerMaterial?.alphaMode === "blend"
            ? 2
            : 0
        : layer.shape?.fillMode === "linear"
          ? 1
          : layer.shape?.fillMode === "radial"
            ? 2
            : 0,
      layer.kind === "mesh"
        ? (layerMaterial?.alphaCutoff ?? 0.5)
        : toRadians(layer.shape?.gradientAngle ?? 0),
      (layer.shape?.dashLength ?? 0) / Math.max(Math.abs(width), 1),
      (layer.shape?.dashGap ?? 0) / Math.max(Math.abs(width), 1),
    ] as const;
    let vertexCount = QUAD_CORNERS.length;
    if (layer.kind === "mesh") {
      if (layer.mesh) {
        vertexCount = appendImportedMesh(
          output,
          layer,
          transform,
          width,
          height,
          color,
          material,
          shapeStyleColor,
          shapeStyleParameters,
          gradientStyleColor,
          gradientStyleParameters,
          composition,
          camera,
        );
      } else {
        const depth = Math.min(width, height) * 0.68;
        vertexCount = CUBE_FACES.length * 6;
        for (const cubeFace of CUBE_FACES) {
          const normal = rotatePoint(...cubeFace.normal, transform.rotation);
          const tangent = rotatePoint(1, 0, 0, transform.rotation);
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
            pushVertex(
              output,
              projected,
              u,
              v,
              color,
              0,
              normal,
              material,
              shapeStyleColor,
              shapeStyleParameters,
              gradientStyleColor,
              gradientStyleParameters,
              [...tangent, 1],
              composition,
            );
          }
        }
      }
    } else if (layer.kind === "shape" && layer.shape?.kind === "bezier" && layer.shape.path) {
      vertexCount = appendBezierPath(
        output,
        layer,
        transform,
        width,
        height,
        color,
        material,
        shapeStyleParameters,
        gradientStyleColor,
        gradientStyleParameters,
        composition,
        camera,
      );
    } else {
      const normal = rotatePoint(0, 0, 1, transform.rotation);
      const tangent = rotatePoint(1, 0, 0, transform.rotation);
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
        pushVertex(
          output,
          projected,
          u,
          v,
          color,
          mediaType,
          normal,
          material,
          shapeStyleColor,
          shapeStyleParameters,
          gradientStyleColor,
          gradientStyleParameters,
          [...tangent, 1],
          composition,
        );
      }
    }
    batches.push({
      layer,
      instanceId: scene.instanceId,
      resourceInstanceId: scene.resourceInstanceId,
      selectionId: scene.selectionId,
      firstVertex,
      vertexCount,
    });
  }
  return { data: new Float32Array(output), batches };
}

function appendBezierPath(
  output: number[],
  layer: Layer,
  transform: EvaluatedTransform,
  width: number,
  height: number,
  fillColor: readonly [number, number, number, number],
  material: readonly [number, number, number, number],
  shapeStyleParameters: readonly [number, number, number, number],
  gradientStyleColor: readonly [number, number, number, number],
  gradientStyleParameters: readonly [number, number, number, number],
  composition: Composition,
  camera?: SceneCamera,
): number {
  const shape = layer.shape;
  if (!shape?.path) return 0;
  const normalized = flattenBezierPath(shape.path);
  const normal = rotatePoint(0, 0, 1, transform.rotation);
  const tangent = rotatePoint(1, 0, 0, transform.rotation);
  const noStyle: readonly [number, number, number, number] = [1, 1, 1, 1];
  let vertexCount = 0;
  const append = (
    point: readonly [number, number],
    color: readonly [number, number, number, number],
    gradientColor: readonly [number, number, number, number],
    gradientParameters: readonly [number, number, number, number],
  ) => {
    const projected = projectVertex(
      point[0] * width,
      point[1] * height,
      0,
      layer.threeDimensional,
      transform.position,
      transform.rotation,
      composition,
      camera,
    );
    pushVertex(
      output,
      projected,
      point[0] + 0.5,
      point[1] + 0.5,
      color,
      0,
      normal,
      material,
      noStyle,
      shapeStyleParameters,
      gradientColor,
      gradientParameters,
      [...tangent, 1],
      composition,
    );
    vertexCount += 1;
  };
  if (shape.path.closed) {
    for (const point of triangulatePolygon(normalized))
      append(point, fillColor, gradientStyleColor, gradientStyleParameters);
  }
  if (shape.strokeWidth > 0) {
    const scaled = normalized.map(
      (point) => [point[0] * width, point[1] * height] as [number, number],
    );
    const trim = shape.trim ?? { start: 0, end: 100, offset: 0 };
    const segments = trimPolyline(
      scaled,
      shape.path.closed,
      trim.start / 100,
      trim.end / 100,
      trim.offset / 100,
    );
    const strokeColor: readonly [number, number, number, number] = [
      shape.strokeColor[0],
      shape.strokeColor[1],
      shape.strokeColor[2],
      shape.strokeColor[3] * transform.opacity,
    ];
    const solidParameters: readonly [number, number, number, number] = [0, 0, 0, 0];
    for (const segment of segments) {
      const stroke = tessellateStroke(
        segment.points,
        shape.strokeWidth,
        segment.closed,
        shape.lineJoin ?? "round",
        shape.lineCap,
      );
      for (const point of stroke)
        append(
          [point[0] / Math.max(Math.abs(width), 1), point[1] / Math.max(Math.abs(height), 1)],
          strokeColor,
          noStyle,
          solidParameters,
        );
    }
  }
  return vertexCount;
}

function appendImportedMesh(
  output: number[],
  layer: Layer,
  transform: EvaluatedTransform,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
  material: readonly [number, number, number, number],
  shapeStyleColor: readonly [number, number, number, number],
  shapeStyleParameters: readonly [number, number, number, number],
  gradientStyleColor: readonly [number, number, number, number],
  gradientStyleParameters: readonly [number, number, number, number],
  composition: Composition,
  camera?: SceneCamera,
): number {
  const mesh = layer.mesh;
  if (!mesh) return 0;
  const bounds = meshBounds(mesh.positions);
  const extents = bounds.maximum.map((value, axis) => value - bounds.minimum[axis]);
  const targetDepth = Math.min(width, height) * 0.68;
  const scales = [width, height, targetDepth]
    .map((target, axis) =>
      extents[axis] > 0.000_001 ? target / extents[axis] : Number.POSITIVE_INFINITY,
    )
    .filter(Number.isFinite);
  const modelScale = scales.length > 0 ? Math.min(...scales) : 1;
  const center = bounds.minimum.map((value, axis) => (value + bounds.maximum[axis]) / 2) as [
    number,
    number,
    number,
  ];
  for (const vertexIndex of mesh.indices) {
    const positionOffset = vertexIndex * 3;
    const uvOffset = vertexIndex * 2;
    const localX = (mesh.positions[positionOffset] - center[0]) * modelScale;
    const localY = -(mesh.positions[positionOffset + 1] - center[1]) * modelScale;
    const localZ = (mesh.positions[positionOffset + 2] - center[2]) * modelScale;
    const normal = rotatePoint(
      mesh.normals[positionOffset],
      -mesh.normals[positionOffset + 1],
      mesh.normals[positionOffset + 2],
      transform.rotation,
    );
    const tangentOffset = vertexIndex * 4;
    const sourceTangent = mesh.tangents?.slice(tangentOffset, tangentOffset + 4) ?? [1, 0, 0, 1];
    const tangent = rotatePoint(
      sourceTangent[0],
      -sourceTangent[1],
      sourceTangent[2],
      transform.rotation,
    );
    const projected = projectVertex(
      localX,
      localY,
      localZ,
      true,
      transform.position,
      transform.rotation,
      composition,
      camera,
    );
    pushVertex(
      output,
      projected,
      mesh.uvs[uvOffset],
      mesh.uvs[uvOffset + 1],
      color,
      0,
      normal,
      material,
      shapeStyleColor,
      shapeStyleParameters,
      gradientStyleColor,
      gradientStyleParameters,
      [tangent[0], tangent[1], tangent[2], -sourceTangent[3]],
      composition,
    );
  }
  return mesh.indices.length;
}

function meshBounds(positions: number[]): {
  minimum: [number, number, number];
  maximum: [number, number, number];
} {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  return { minimum, maximum };
}

function projectVertex(
  localX: number,
  localY: number,
  localZ: number,
  threeDimensional: boolean,
  position: [number, number, number],
  rotation: [number, number, number],
  composition: Composition,
  camera?: SceneCamera,
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
  const cameraPosition = camera?.transform.position ?? [
    composition.width / 2,
    composition.height / 2,
    0,
  ];
  const relative: [number, number, number] = [
    world[0] - cameraPosition[0],
    world[1] - cameraPosition[1],
    world[2] - cameraPosition[2],
  ];
  const [viewX, viewY, viewZ] = applyInverseRotation(
    relative,
    camera?.transform.rotation ?? [0, 0, 0],
  );
  const settings = camera?.settings ?? {
    projection: "perspective",
    fieldOfView: 45,
    orthographicSize: composition.height,
  };
  const focalLength = composition.height / (2 * Math.tan(toRadians(settings.fieldOfView) / 2));
  const perspective =
    settings.projection === "orthographic"
      ? composition.height / settings.orthographicSize
      : focalLength / Math.max(focalLength * 0.08, focalLength - viewZ);
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
  shapeStyleColor: readonly [number, number, number, number],
  shapeStyleParameters: readonly [number, number, number, number],
  gradientStyleColor: readonly [number, number, number, number],
  gradientStyleParameters: readonly [number, number, number, number],
  tangent: readonly [number, number, number, number],
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
    ...shapeStyleColor,
    ...shapeStyleParameters,
    ...gradientStyleColor,
    ...gradientStyleParameters,
    ...tangent,
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
