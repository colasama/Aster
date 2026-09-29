import { solidRenderSize } from "../layers/solid-layer";
import type { Composition, EvaluatedTransform, Layer } from "../types";
import { type CameraPose, type CameraProjection, type Vector3, worldToCamera } from "./camera-rig";
import {
  activeCameraLayerAtTime,
  createDefaultCameraSettings,
  createDefaultEvaluatedCamera,
  evaluateCameraSettings,
} from "./camera-settings";
import { evaluateWorldTransform, isLayerActiveAtTime } from "./scene-evaluation";

export interface CameraFitOptions {
  /** Camera layer to fit against; defaults to the active camera at each sample time. */
  cameraId?: string;
  /** Extra coverage beyond the frame edge, in composition pixels. */
  margin?: number;
  start?: number;
  end?: number;
  /** Maximum number of evenly spaced samples along the span (default: one per frame, ≤ 240). */
  samples?: number;
}

export interface CameraFitResult {
  /** Uniform XY scale multiplier that just covers the frame at every sample. */
  scaleMultiplier: number;
  /** Sample that required the largest multiplier. */
  criticalTime: number;
  samples: number;
  start: number;
  end: number;
  alreadyCovered: boolean;
}

const MAX_MULTIPLIER = 1000;

/**
 * Finds the smallest uniform XY scale multiplier for a 3D layer so its quad covers the whole
 * frame (plus margin) along the camera path. Uses the renderer's quad and projection model.
 */
export function fitLayerToCamera(
  composition: Composition,
  layer: Layer,
  options: CameraFitOptions = {},
): CameraFitResult {
  if (!layer.threeDimensional)
    throw new Error("Camera fitting requires a 3D layer; enable threeDimensional first");
  const camera = options.cameraId
    ? composition.layers.find((candidate) => candidate.id === options.cameraId)
    : undefined;
  if (options.cameraId && camera?.kind !== "camera")
    throw new Error(`Camera layer does not exist in this composition: ${options.cameraId}`);
  const frame = composition.frameRate.denominator / composition.frameRate.numerator;
  const start = Math.max(options.start ?? layer.inPoint, layer.inPoint, camera?.inPoint ?? 0);
  const end = Math.min(
    options.end ?? layer.outPoint,
    layer.outPoint,
    camera?.outPoint ?? composition.duration,
  );
  if (!(end > start)) throw new Error("The layer and camera share no active time to fit");
  const count = Math.max(
    1,
    Math.min(options.samples ?? 240, 240, Math.ceil((end - start) / frame - 1e-9)),
  );
  const margin = Math.max(0, options.margin ?? 0);
  let scaleMultiplier = 0;
  let criticalTime = start;
  for (let index = 0; index < count; index++) {
    const time = count === 1 ? start : start + ((end - start - frame) * index) / (count - 1);
    if (!isLayerActiveAtTime(layer, time)) continue;
    const view = cameraAtTime(composition, camera, time);
    const transform = evaluateWorldTransform(layer, composition, time);
    const required = requiredMultiplier(layer, transform, view, composition, margin, time);
    if (required > scaleMultiplier) {
      scaleMultiplier = required;
      criticalTime = time;
    }
  }
  return {
    scaleMultiplier: Math.round(scaleMultiplier * 10_000) / 10_000,
    criticalTime,
    samples: count,
    start,
    end,
    alreadyCovered: scaleMultiplier <= 1,
  };
}

interface CameraView {
  pose: CameraPose;
  projection: CameraProjection;
}

function cameraAtTime(composition: Composition, camera: Layer | undefined, time: number) {
  const layer = camera ?? activeCameraLayerAtTime(composition, time);
  if (!layer) return createDefaultEvaluatedCamera(composition.width, composition.height);
  const settings =
    layer.camera ?? createDefaultCameraSettings(composition.width, composition.height);
  return evaluateCameraSettings(
    settings,
    evaluateWorldTransform(layer, composition, time),
    time,
    composition.width,
  );
}

function requiredMultiplier(
  layer: Layer,
  transform: EvaluatedTransform,
  view: CameraView,
  composition: Composition,
  margin: number,
  time: number,
): number {
  const covers = (multiplier: number) =>
    coversFrame(quadCorners(layer, transform, multiplier), view, composition, margin);
  if (covers(1)) {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (covers(middle)) high = middle;
      else low = middle;
    }
    return high;
  }
  let low = 1;
  let high = 2;
  while (!covers(high)) {
    low = high;
    high *= 2;
    if (high > MAX_MULTIPLIER)
      throw new Error(
        `Layer cannot cover the frame at ${time.toFixed(3)}s (it may be edge-on to the camera or behind it)`,
      );
  }
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (covers(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/** World-space corners of the rendered quad with the layer's XY scale multiplied. */
function quadCorners(layer: Layer, transform: EvaluatedTransform, multiplier: number): Vector3[] {
  const [sourceWidth, sourceHeight] = solidRenderSize(layer);
  const scaleX = (transform.scale[0] * multiplier) / 100;
  const scaleY = (transform.scale[1] * multiplier) / 100;
  const scaleZ = transform.scale[2] / 100;
  const width = Math.abs(sourceWidth * scaleX);
  const height = Math.abs(sourceHeight * scaleY);
  const offset: Vector3 = [
    (sourceWidth * 0.5 - transform.anchor[0]) * scaleX,
    (sourceHeight * 0.5 - transform.anchor[1]) * scaleY,
    -transform.anchor[2] * scaleZ,
  ];
  return [
    [-width / 2, -height / 2, 0],
    [width / 2, -height / 2, 0],
    [width / 2, height / 2, 0],
    [-width / 2, height / 2, 0],
  ].map((corner) =>
    add(transform.position, rotate(add(corner as Vector3, offset), transform.rotation)),
  );
}

/** Clips the quad at the near plane, projects it, and tests the expanded frame corners. */
function coversFrame(
  corners: readonly Vector3[],
  view: CameraView,
  composition: Composition,
  margin: number,
): boolean {
  const near = view.projection.near;
  const cameraSpace = corners.map((corner) => worldToCamera(corner, view.pose));
  const clipped: Vector3[] = [];
  for (let index = 0; index < cameraSpace.length; index++) {
    const current = cameraSpace[index];
    const next = cameraSpace[(index + 1) % cameraSpace.length];
    const currentInside = current[2] >= near;
    const nextInside = next[2] >= near;
    if (currentInside) clipped.push(current);
    if (currentInside !== nextInside) {
      const t = (near - current[2]) / (next[2] - current[2]);
      clipped.push([
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
        near,
      ]);
    }
  }
  if (clipped.length < 3) return false;
  const width = composition.width;
  const height = composition.height;
  const perspective = view.projection.kind === "perspective";
  const orthographicScale = height / Math.max(1e-6, view.projection.orthographicSize);
  const polygon = clipped.map(([x, y, z]) => {
    const factor = perspective ? view.projection.zoom / Math.max(z, 1e-6) : orthographicScale;
    return [width / 2 + x * factor, height / 2 + y * factor] as const;
  });
  const frame = [
    [-margin, -margin],
    [width + margin, -margin],
    [width + margin, height + margin],
    [-margin, height + margin],
  ] as const;
  return frame.every((point) => insideConvex(point, polygon));
}

function insideConvex(
  point: readonly [number, number],
  polygon: ReadonlyArray<readonly [number, number]>,
): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const [ax, ay] = polygon[index];
    const [bx, by] = polygon[(index + 1) % polygon.length];
    const cross = (bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax);
    if (Math.abs(cross) < 1e-9) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return sign !== 0;
}

function rotate(vector: Vector3, rotation: readonly number[]): Vector3 {
  let [x, y, z] = vector;
  const [rx, ry, rz] = rotation.map((degrees) => ((degrees ?? 0) * Math.PI) / 180);
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x, y, z];
}

function add(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}
