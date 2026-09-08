import {
  projectCameraPoint,
  unprojectCameraPoint,
  type Vector2,
  type Vector3,
} from "../core/camera-rig";
import type { EvaluatedCamera } from "../core/camera-settings";
import { evaluateWorldTransform, flattenSceneLayers } from "../core/scene-evaluation";
import { solidRenderSize } from "../core/solid-layer";
import type { Composition, EvaluatedTransform, Layer, Project } from "../core/types";
import { hitTestViewportTransform } from "./transform-interaction";

export type TransformSpace3d = "local" | "world";
export type TransformAxis3d = "x" | "y" | "z";

export interface ProjectedLayer3d {
  readonly outline: readonly Vector2[];
  readonly origin: Vector2;
  readonly cameraDepth: number;
}

export interface ProjectedGizmoAxis3d {
  readonly axis: TransformAxis3d;
  readonly basis: Vector3;
  readonly start: Vector2;
  readonly end: Vector2;
  /** Screen-space unit direction in composition pixels. */
  readonly screenDirection: Vector2;
  /** World-space distance represented by the visible axis. */
  readonly worldLength: number;
}

/** Selects the first visible scene layer under the pointer, including locked and 3D layers. */
export function hitTestSceneLayerAtPoint(
  composition: Composition,
  project: Project,
  time: number,
  point: Vector2,
  camera: EvaluatedCamera,
): Layer | undefined {
  const hit = flattenSceneLayers(composition, project, time).find(({ layer, transform }) => {
    if (
      layer.kind === "audio" ||
      layer.kind === "camera" ||
      layer.kind === "light" ||
      layer.kind === "adjustment"
    )
      return false;
    if (layer.threeDimensional) {
      const bounds = projectLayerBounds3d(layer, transform, composition, camera);
      return bounds ? hitTestProjectedLayer3d(point, bounds, 3) : false;
    }
    return hitTestViewportTransform(
      point,
      {
        position: [transform.position[0], transform.position[1]],
        scale: [transform.scale[0], transform.scale[1]],
        rotation: transform.rotation[2],
        anchor: [transform.anchor[0], transform.anchor[1]],
        size: solidRenderSize(layer),
      },
      2,
    );
  });
  return hit ? composition.layers.find((layer) => layer.id === hit.selectionId) : undefined;
}

const AXES: ReadonlyArray<readonly [TransformAxis3d, Vector3]> = [
  ["x", [1, 0, 0]],
  ["y", [0, 1, 0]],
  ["z", [0, 0, 1]],
];

/**
 * Projects the same bounded quad/box used by the realtime renderer. Imported meshes
 * intentionally use their fitted render box here, keeping picking O(1) and avoiding
 * a GPU readback or a scan over every source vertex.
 */
export function projectLayerBounds3d(
  layer: Layer,
  transform: EvaluatedTransform,
  composition: Composition,
  camera: EvaluatedCamera,
): ProjectedLayer3d | undefined {
  const [sourceWidth, sourceHeight] = solidRenderSize(layer);
  const width = Math.abs((sourceWidth * transform.scale[0]) / 100);
  const height = Math.abs((sourceHeight * transform.scale[1]) / 100);
  const depth = layer.kind === "mesh" ? Math.min(width, height) * 0.68 : 0;
  const anchorOffset: Vector3 = [
    ((sourceWidth * 0.5 - transform.anchor[0]) * transform.scale[0]) / 100,
    ((sourceHeight * 0.5 - transform.anchor[1]) * transform.scale[1]) / 100,
    (-transform.anchor[2] * transform.scale[2]) / 100,
  ];
  const centeredCorners: Vector3[] =
    depth > 0
      ? [
          [-width / 2, -height / 2, -depth / 2],
          [width / 2, -height / 2, -depth / 2],
          [-width / 2, height / 2, -depth / 2],
          [width / 2, height / 2, -depth / 2],
          [-width / 2, -height / 2, depth / 2],
          [width / 2, -height / 2, depth / 2],
          [-width / 2, height / 2, depth / 2],
          [width / 2, height / 2, depth / 2],
        ]
      : [
          [-width / 2, -height / 2, 0],
          [width / 2, -height / 2, 0],
          [-width / 2, height / 2, 0],
          [width / 2, height / 2, 0],
        ];
  const projected = centeredCorners
    .map((point) => add3(point, anchorOffset))
    .map((point) => add3(transform.position, rotateVector3d(point, transform.rotation)))
    .map((point) =>
      projectCameraPoint(point, camera.pose, camera.projection, [
        composition.width,
        composition.height,
      ]),
    )
    .filter(
      (point) =>
        Number.isFinite(point.screen[0]) &&
        Number.isFinite(point.screen[1]) &&
        point.cameraDepth >= camera.projection.near &&
        point.cameraDepth <= camera.projection.far,
    );
  const origin = projectCameraPoint(transform.position, camera.pose, camera.projection, [
    composition.width,
    composition.height,
  ]);
  if (projected.length === 0 || origin.cameraDepth < camera.projection.near) return undefined;
  return {
    outline: convexHull(projected.map((point) => point.screen)),
    origin: origin.screen,
    cameraDepth: origin.cameraDepth,
  };
}

export function hitTestProjectedLayer3d(
  point: Vector2,
  projected: ProjectedLayer3d,
  tolerance = 3,
): boolean {
  if (projected.outline.length < 3)
    return distance2(point, projected.origin) <= Math.max(6, tolerance);
  if (pointInConvexPolygon(point, projected.outline)) return true;
  return projected.outline.some((start, index) => {
    const end = projected.outline[(index + 1) % projected.outline.length];
    return Boolean(end && distanceToSegment(point, start, end) <= tolerance);
  });
}

export function projectedGizmoAxes3d(
  transform: EvaluatedTransform,
  composition: Composition,
  camera: EvaluatedCamera,
  space: TransformSpace3d,
  zoom: number,
): readonly ProjectedGizmoAxis3d[] {
  const origin = projectCameraPoint(transform.position, camera.pose, camera.projection, [
    composition.width,
    composition.height,
  ]);
  const safeZoom = Math.max(zoom, 0.0001);
  const worldPerPixel =
    camera.projection.kind === "perspective"
      ? origin.cameraDepth / Math.max(camera.projection.zoom, 0.0001)
      : camera.projection.orthographicSize / composition.height;
  const worldLength = Math.max(0.0001, (72 / safeZoom) * worldPerPixel);
  return AXES.map(([axis, canonical], index) => {
    const basis =
      space === "local" ? normalize3(rotateVector3d(canonical, transform.rotation)) : canonical;
    const endpoint = projectCameraPoint(
      add3(transform.position, scale3(basis, worldLength)),
      camera.pose,
      camera.projection,
      [composition.width, composition.height],
    ).screen;
    const projectedDirection: Vector2 = [
      endpoint[0] - origin.screen[0],
      endpoint[1] - origin.screen[1],
    ];
    const projectedLength = Math.hypot(...projectedDirection);
    // An axis aimed directly into the camera projects to a point. Use a stable
    // diagonal fallback for its draggable depth handle while retaining its 3D basis.
    const screenDirection: Vector2 =
      projectedLength >= 6 / safeZoom
        ? [projectedDirection[0] / projectedLength, projectedDirection[1] / projectedLength]
        : depthAxisFallback(index);
    const visibleLength = projectedLength >= 6 / safeZoom ? projectedLength : 42 / safeZoom;
    return {
      axis,
      basis,
      start: origin.screen,
      end: [
        origin.screen[0] + screenDirection[0] * visibleLength,
        origin.screen[1] + screenDirection[1] * visibleLength,
      ],
      screenDirection,
      worldLength,
    };
  });
}

export function axisConstrainedWorldDelta(
  pointerDelta: Vector2,
  axis: ProjectedGizmoAxis3d,
): Vector3 {
  const visiblePixels = Math.max(distance2(axis.start, axis.end), 0.0001);
  const projectedPixels =
    pointerDelta[0] * axis.screenDirection[0] + pointerDelta[1] * axis.screenDirection[1];
  return scale3(axis.basis, (projectedPixels / visiblePixels) * axis.worldLength);
}

export function viewPlaneWorldDelta(
  start: Vector2,
  current: Vector2,
  worldOrigin: Vector3,
  composition: Composition,
  camera: EvaluatedCamera,
): Vector3 {
  const origin = projectCameraPoint(worldOrigin, camera.pose, camera.projection, [
    composition.width,
    composition.height,
  ]);
  const initial = unprojectCameraPoint(start, origin.cameraDepth, camera.pose, camera.projection, [
    composition.width,
    composition.height,
  ]);
  const next = unprojectCameraPoint(current, origin.cameraDepth, camera.pose, camera.projection, [
    composition.width,
    composition.height,
  ]);
  return subtract3(next, initial);
}

/** Inverts the parent transform semantics used by evaluateWorldTransform. */
export function worldPositionToLayerPosition(
  layer: Layer,
  worldPosition: Vector3,
  composition: Composition,
  time: number,
): Vector3 {
  if (!layer.parentId) return worldPosition;
  const parent = composition.layers.find((candidate) => candidate.id === layer.parentId);
  if (!parent) return worldPosition;
  const world = evaluateWorldTransform(parent, composition, time);
  const radians = (-world.rotation[2] * Math.PI) / 180;
  const deltaX = worldPosition[0] - world.position[0];
  const deltaY = worldPosition[1] - world.position[1];
  const rotatedX = deltaX * Math.cos(radians) - deltaY * Math.sin(radians);
  const rotatedY = deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
  return [
    rotatedX / safeScale(world.scale[0] / 100),
    rotatedY / safeScale(world.scale[1] / 100),
    (worldPosition[2] - world.position[2]) / safeScale(world.scale[2] / 100),
  ];
}

export function rotateVector3d(vector: Vector3, rotation: readonly number[]): Vector3 {
  let [x, y, z] = vector;
  const xRadians = radians(rotation[0] ?? 0);
  const yRadians = radians(rotation[1] ?? 0);
  const zRadians = radians(rotation[2] ?? 0);
  [y, z] = [
    y * Math.cos(xRadians) - z * Math.sin(xRadians),
    y * Math.sin(xRadians) + z * Math.cos(xRadians),
  ];
  [x, z] = [
    x * Math.cos(yRadians) + z * Math.sin(yRadians),
    -x * Math.sin(yRadians) + z * Math.cos(yRadians),
  ];
  [x, y] = [
    x * Math.cos(zRadians) - y * Math.sin(zRadians),
    x * Math.sin(zRadians) + y * Math.cos(zRadians),
  ];
  return [x, y, z];
}

function convexHull(points: readonly Vector2[]): Vector2[] {
  const sorted = [...points].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (sorted.length <= 2) return sorted;
  const half = (input: readonly Vector2[]) => {
    const output: Vector2[] = [];
    for (const point of input) {
      while (output.length >= 2) {
        const previous = output[output.length - 2];
        const current = output[output.length - 1];
        if (!previous || !current || cross2(previous, current, point) > 0) break;
        output.pop();
      }
      output.push(point);
    }
    return output;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function pointInConvexPolygon(point: Vector2, polygon: readonly Vector2[]): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (!start || !end) continue;
    const value = cross2(start, end, point);
    if (Math.abs(value) < 0.000001) continue;
    const nextSign = Math.sign(value);
    if (sign !== 0 && nextSign !== sign) return false;
    sign = nextSign;
  }
  return true;
}

function distanceToSegment(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const t =
    denominator <= 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator),
        );
  return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dy * t));
}

function cross2(origin: Vector2, end: Vector2, point: Vector2): number {
  return (
    (end[0] - origin[0]) * (point[1] - origin[1]) - (end[1] - origin[1]) * (point[0] - origin[0])
  );
}

function depthAxisFallback(index: number): Vector2 {
  if (index === 0) return [1, 0];
  if (index === 1) return [0, 1];
  const inverseSqrt2 = Math.SQRT1_2;
  return [inverseSqrt2, -inverseSqrt2];
}

function add3(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract3(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale3(vector: Vector3, value: number): Vector3 {
  return [vector[0] * value, vector[1] * value, vector[2] * value];
}

function normalize3(vector: Vector3): Vector3 {
  const length = Math.hypot(...vector);
  return length > 0.000001 ? scale3(vector, 1 / length) : [1, 0, 0];
}

function distance2(left: Vector2, right: Vector2): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function safeScale(value: number): number {
  if (Math.abs(value) >= 0.000001) return value;
  return value < 0 ? -0.000001 : 0.000001;
}
