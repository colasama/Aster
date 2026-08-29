export type Vector2 = [number, number];
export type Vector3 = [number, number, number];

export interface CameraPose {
  mode: "oneNode" | "twoNode";
  position: Vector3;
  pointOfInterest: Vector3;
  orientation: Vector3;
  rotation: Vector3;
}

export interface CameraBasis {
  right: Vector3;
  down: Vector3;
  forward: Vector3;
}

export interface CameraProjection {
  kind: "perspective" | "orthographic";
  zoom: number;
  orthographicSize: number;
  near: number;
  far: number;
}

export interface ProjectedCameraPoint {
  screen: Vector2;
  cameraDepth: number;
  normalizedDepth: number;
  visible: boolean;
}

export interface CameraRay {
  origin: Vector3;
  direction: Vector3;
}

const EPSILON = 1e-6;

/** Creates AE's default camera: the composition plane is exactly one Zoom away. */
export function createDefaultCameraPose(
  compositionWidth: number,
  compositionHeight: number,
  zoom: number,
): CameraPose {
  const center: Vector3 = [finite(compositionWidth) * 0.5, finite(compositionHeight) * 0.5, 0];
  return {
    mode: "twoNode",
    position: [center[0], center[1], -positive(zoom, 1)],
    pointOfInterest: center,
    orientation: [0, 0, 0],
    rotation: [0, 0, 0],
  };
}

/** Resolves a stable right/down/forward frame for one-node and point-of-interest cameras. */
export function evaluateCameraBasis(pose: CameraPose): CameraBasis {
  const position = normalizeVector(pose.position);
  const point = normalizeVector(pose.pointOfInterest);
  let forward: Vector3 =
    pose.mode === "twoNode" ? normalize(subtract(point, position), [0, 0, 1]) : [0, 0, 1];
  const referenceDown: Vector3 = Math.abs(dot(forward, [0, 1, 0])) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  let right = normalize(cross(referenceDown, forward), [1, 0, 0]);
  let down = normalize(cross(forward, right), [0, 1, 0]);
  const rotation: Vector3 = [
    finite(pose.orientation[0]) + finite(pose.rotation[0]),
    finite(pose.orientation[1]) + finite(pose.rotation[1]),
    finite(pose.orientation[2]) + finite(pose.rotation[2]),
  ];
  ({ right, down, forward } = rotateBasis({ right, down, forward }, right, rotation[0]));
  ({ right, down, forward } = rotateBasis({ right, down, forward }, down, rotation[1]));
  ({ right, down, forward } = rotateBasis({ right, down, forward }, forward, rotation[2]));
  right = normalize(right, [1, 0, 0]);
  forward = normalize(forward, [0, 0, 1]);
  down = normalize(cross(forward, right), [0, 1, 0]);
  right = normalize(cross(down, forward), [1, 0, 0]);
  return { right, down, forward };
}

export function worldToCamera(point: Vector3, pose: CameraPose): Vector3 {
  const basis = evaluateCameraBasis(pose);
  const relative = subtract(normalizeVector(point), normalizeVector(pose.position));
  return [dot(relative, basis.right), dot(relative, basis.down), dot(relative, basis.forward)];
}

export function cameraToWorld(point: Vector3, pose: CameraPose): Vector3 {
  const basis = evaluateCameraBasis(pose);
  return add(
    normalizeVector(pose.position),
    add(
      scale(basis.right, finite(point[0])),
      add(scale(basis.down, finite(point[1])), scale(basis.forward, finite(point[2]))),
    ),
  );
}

/** Projects with AE Zoom in composition pixels; a plane at depth Zoom retains its dimensions. */
export function projectCameraPoint(
  point: Vector3,
  pose: CameraPose,
  projection: CameraProjection,
  compositionSize: Vector2,
): ProjectedCameraPoint {
  const width = positive(compositionSize[0], 1);
  const height = positive(compositionSize[1], 1);
  const camera = worldToCamera(point, pose);
  const depth = camera[2];
  const near = positive(projection.near, 0.01);
  const far = Math.max(near + EPSILON, positive(projection.far, 1_000_000));
  const perspective = projection.kind === "perspective";
  const scaleFactor = perspective
    ? positive(projection.zoom, 1) / Math.max(depth, EPSILON)
    : height / positive(projection.orthographicSize, height);
  const screen: Vector2 = [
    width * 0.5 + camera[0] * scaleFactor,
    height * 0.5 + camera[1] * scaleFactor,
  ];
  const normalizedDepth = perspective
    ? far / (far - near) - (far * near) / ((far - near) * Math.max(depth, EPSILON))
    : (depth - near) / (far - near);
  return {
    screen,
    cameraDepth: depth,
    normalizedDepth,
    visible:
      depth >= near &&
      depth <= far &&
      screen[0] >= 0 &&
      screen[0] <= width &&
      screen[1] >= 0 &&
      screen[1] <= height,
  };
}

export function unprojectCameraPoint(
  screen: Vector2,
  cameraDepth: number,
  pose: CameraPose,
  projection: CameraProjection,
  compositionSize: Vector2,
): Vector3 {
  const width = positive(compositionSize[0], 1);
  const height = positive(compositionSize[1], 1);
  const depth = positive(cameraDepth, EPSILON);
  const inverseScale =
    projection.kind === "perspective"
      ? depth / positive(projection.zoom, 1)
      : positive(projection.orthographicSize, height) / height;
  return cameraToWorld(
    [
      (finite(screen[0]) - width * 0.5) * inverseScale,
      (finite(screen[1]) - height * 0.5) * inverseScale,
      depth,
    ],
    pose,
  );
}

export function cameraRayFromScreen(
  screen: Vector2,
  pose: CameraPose,
  projection: CameraProjection,
  compositionSize: Vector2,
): CameraRay {
  const width = positive(compositionSize[0], 1);
  const height = positive(compositionSize[1], 1);
  const basis = evaluateCameraBasis(pose);
  const cameraOffset: Vector3 = [
    finite(screen[0]) - width * 0.5,
    finite(screen[1]) - height * 0.5,
    0,
  ];
  if (projection.kind === "orthographic") {
    const worldPerPixel = positive(projection.orthographicSize, height) / height;
    return {
      origin: add(
        normalizeVector(pose.position),
        add(
          scale(basis.right, cameraOffset[0] * worldPerPixel),
          scale(basis.down, cameraOffset[1] * worldPerPixel),
        ),
      ),
      direction: basis.forward,
    };
  }
  return {
    origin: normalizeVector(pose.position),
    direction: normalize(
      add(
        scale(basis.forward, positive(projection.zoom, 1)),
        add(scale(basis.right, cameraOffset[0]), scale(basis.down, cameraOffset[1])),
      ),
      basis.forward,
    ),
  };
}

/** Orbits a two-node camera without changing its point-of-interest distance. */
export function orbitCamera(
  pose: CameraPose,
  yawDegrees: number,
  pitchDegrees: number,
): CameraPose {
  if (pose.mode === "oneNode")
    return {
      ...pose,
      rotation: [
        finite(pose.rotation[0]) + finite(pitchDegrees),
        finite(pose.rotation[1]) + finite(yawDegrees),
        finite(pose.rotation[2]),
      ],
    };
  const point = normalizeVector(pose.pointOfInterest);
  const initial = subtract(normalizeVector(pose.position), point);
  const distance = length(initial);
  if (distance <= EPSILON) return pose;
  let offset = rotateAroundAxis(initial, [0, 1, 0], finite(yawDegrees));
  const yawedPose = { ...pose, position: add(point, offset) };
  offset = rotateAroundAxis(offset, evaluateCameraBasis(yawedPose).right, finite(pitchDegrees));
  offset = scale(normalize(offset, initial), distance);
  return { ...pose, position: add(point, offset) };
}

/** Translates camera and POI in view-plane pixels at a chosen camera-space depth. */
export function panCamera(
  pose: CameraPose,
  deltaPixels: Vector2,
  depth: number,
  projection: CameraProjection,
  compositionHeight: number,
): CameraPose {
  const basis = evaluateCameraBasis(pose);
  const worldPerPixel =
    projection.kind === "perspective"
      ? positive(depth, 1) / positive(projection.zoom, 1)
      : positive(projection.orthographicSize, compositionHeight) / positive(compositionHeight, 1);
  const translation = add(
    scale(basis.right, finite(deltaPixels[0]) * worldPerPixel),
    scale(basis.down, finite(deltaPixels[1]) * worldPerPixel),
  );
  return {
    ...pose,
    position: add(normalizeVector(pose.position), translation),
    pointOfInterest: add(normalizeVector(pose.pointOfInterest), translation),
  };
}

/** Dollies along the viewing direction and never crosses a two-node point of interest. */
export function dollyCamera(pose: CameraPose, distance: number): CameraPose {
  const basis = evaluateCameraBasis(pose);
  const maximum =
    pose.mode === "twoNode"
      ? Math.max(
          0,
          length(subtract(normalizeVector(pose.pointOfInterest), normalizeVector(pose.position))) -
            EPSILON,
        )
      : Number.POSITIVE_INFINITY;
  const movement = Math.min(maximum, finite(distance));
  return { ...pose, position: add(normalizeVector(pose.position), scale(basis.forward, movement)) };
}

function rotateBasis(basis: CameraBasis, axis: Vector3, degrees: number): CameraBasis {
  if (Math.abs(degrees) <= EPSILON) return basis;
  return {
    right: rotateAroundAxis(basis.right, axis, degrees),
    down: rotateAroundAxis(basis.down, axis, degrees),
    forward: rotateAroundAxis(basis.forward, axis, degrees),
  };
}

function rotateAroundAxis(vector: Vector3, rawAxis: Vector3, degrees: number): Vector3 {
  const axis = normalize(rawAxis, [1, 0, 0]);
  const radians = (finite(degrees) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return add(
    add(scale(vector, cosine), scale(cross(axis, vector), sine)),
    scale(axis, dot(axis, vector) * (1 - cosine)),
  );
}

function normalizeVector(value: Vector3): Vector3 {
  return [finite(value[0]), finite(value[1]), finite(value[2])];
}

function add(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(value: Vector3, multiplier: number): Vector3 {
  return [value[0] * multiplier, value[1] * multiplier, value[2] * multiplier];
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function length(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value: Vector3, fallback: Vector3): Vector3 {
  const magnitude = length(value);
  return magnitude > EPSILON && Number.isFinite(magnitude)
    ? scale(value, 1 / magnitude)
    : normalizeVector(fallback);
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
