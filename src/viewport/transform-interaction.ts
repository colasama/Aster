export type Point2 = readonly [number, number];

export interface ViewportTransform2d {
  position: Point2;
  scale: Point2;
  rotation: number;
  anchor: Point2;
  size: Point2;
}

export interface ViewportBounds2d {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ViewportSnapTarget {
  axis: "x" | "y";
  value: number;
  kind: "composition" | "guide" | "layer";
  id: string;
}

export interface ViewportSnapResult {
  position: Point2;
  snapped: readonly ViewportSnapTarget[];
}

export type ViewportResizeHandle =
  | "northWest"
  | "north"
  | "northEast"
  | "east"
  | "southEast"
  | "south"
  | "southWest"
  | "west";

export interface ViewportResizeOptions {
  preserveAspectRatio?: boolean;
  fromAnchor?: boolean;
  minimumScale?: number;
}

export function localToComposition(point: Point2, transform: ViewportTransform2d): Point2 {
  const scaled: Point2 = [
    (point[0] - transform.anchor[0]) * (transform.scale[0] / 100),
    (point[1] - transform.anchor[1]) * (transform.scale[1] / 100),
  ];
  const rotated = rotate(scaled, transform.rotation);
  return [transform.position[0] + rotated[0], transform.position[1] + rotated[1]];
}

export function compositionToLocal(point: Point2, transform: ViewportTransform2d): Point2 {
  const translated: Point2 = [point[0] - transform.position[0], point[1] - transform.position[1]];
  const unrotated = rotate(translated, -transform.rotation);
  return [
    transform.anchor[0] + unrotated[0] / safeScale(transform.scale[0] / 100),
    transform.anchor[1] + unrotated[1] / safeScale(transform.scale[1] / 100),
  ];
}

export function hitTestViewportTransform(
  point: Point2,
  transform: ViewportTransform2d,
  padding = 0,
): boolean {
  const local = compositionToLocal(point, transform);
  return (
    local[0] >= -padding &&
    local[1] >= -padding &&
    local[0] <= transform.size[0] + padding &&
    local[1] <= transform.size[1] + padding
  );
}

export function viewportTransformBounds(transform: ViewportTransform2d): ViewportBounds2d {
  const corners = [
    localToComposition([0, 0], transform),
    localToComposition([transform.size[0], 0], transform),
    localToComposition([transform.size[0], transform.size[1]], transform),
    localToComposition([0, transform.size[1]], transform),
  ];
  return {
    left: Math.min(...corners.map((point) => point[0])),
    top: Math.min(...corners.map((point) => point[1])),
    right: Math.max(...corners.map((point) => point[0])),
    bottom: Math.max(...corners.map((point) => point[1])),
  };
}

/** Moves the anchor without moving any rendered point. */
export function moveAnchorPreservingGeometry(
  transform: ViewportTransform2d,
  anchor: Point2,
): ViewportTransform2d {
  const delta: Point2 = [
    (anchor[0] - transform.anchor[0]) * (transform.scale[0] / 100),
    (anchor[1] - transform.anchor[1]) * (transform.scale[1] / 100),
  ];
  const positionDelta = rotate(delta, transform.rotation);
  return {
    ...transform,
    anchor,
    position: [transform.position[0] + positionDelta[0], transform.position[1] + positionDelta[1]],
  };
}

/** Resizes in layer-local axes while keeping the opposite handle (or anchor) fixed in composition. */
export function resizeViewportTransform(
  transform: ViewportTransform2d,
  handle: ViewportResizeHandle,
  pointer: Point2,
  options: ViewportResizeOptions = {},
): ViewportTransform2d {
  const handlePoint = resizeHandlePoint(handle, transform.size);
  const fixedPoint = options.fromAnchor
    ? transform.anchor
    : resizeHandlePoint(oppositeResizeHandle(handle), transform.size);
  const fixedComposition = localToComposition(fixedPoint, transform);
  const pointerDelta = rotate(
    [pointer[0] - fixedComposition[0], pointer[1] - fixedComposition[1]],
    -transform.rotation,
  );
  const localDelta: Point2 = [handlePoint[0] - fixedPoint[0], handlePoint[1] - fixedPoint[1]];
  const horizontal = handleHasHorizontalAxis(handle) && Math.abs(localDelta[0]) > 1e-6;
  const vertical = handleHasVerticalAxis(handle) && Math.abs(localDelta[1]) > 1e-6;
  let scaleX = horizontal ? (pointerDelta[0] / localDelta[0]) * 100 : transform.scale[0];
  let scaleY = vertical ? (pointerDelta[1] / localDelta[1]) * 100 : transform.scale[1];
  if (options.preserveAspectRatio && horizontal && vertical) {
    const factorX = scaleX / safeScale(transform.scale[0]);
    const factorY = scaleY / safeScale(transform.scale[1]);
    const factor = Math.abs(factorX - 1) >= Math.abs(factorY - 1) ? factorX : factorY;
    scaleX = transform.scale[0] * factor;
    scaleY = transform.scale[1] * factor;
  }
  const minimum = Math.max(1e-4, Math.abs(options.minimumScale ?? 0.01));
  const scale: Point2 = [boundedSignedScale(scaleX, minimum), boundedSignedScale(scaleY, minimum)];
  const fixedOffset = rotate(
    [
      (fixedPoint[0] - transform.anchor[0]) * (scale[0] / 100),
      (fixedPoint[1] - transform.anchor[1]) * (scale[1] / 100),
    ],
    transform.rotation,
  );
  return {
    ...transform,
    scale,
    position: [fixedComposition[0] - fixedOffset[0], fixedComposition[1] - fixedOffset[1]],
  };
}

/** Applies pointer-angle delta around the rendered anchor, optionally snapping to fixed degrees. */
export function rotateViewportTransformFromPointer(
  transform: ViewportTransform2d,
  startPointer: Point2,
  pointer: Point2,
  snapDegrees = 0,
): ViewportTransform2d {
  const center = transform.position;
  const startAngle = Math.atan2(startPointer[1] - center[1], startPointer[0] - center[0]);
  const angle = Math.atan2(pointer[1] - center[1], pointer[0] - center[0]);
  const delta = ((angle - startAngle) * 180) / Math.PI;
  const unsnapped = transform.rotation + (Number.isFinite(delta) ? delta : 0);
  const increment = Math.abs(Number.isFinite(snapDegrees) ? snapDegrees : 0);
  return {
    ...transform,
    rotation: increment > 1e-6 ? Math.round(unsnapped / increment) * increment : unsnapped,
  };
}

export function viewportSnapTargets(
  compositionSize: Point2,
  guides: { horizontal?: readonly number[]; vertical?: readonly number[] } = {},
  layerBounds: readonly (ViewportBounds2d & { id: string })[] = [],
): readonly ViewportSnapTarget[] {
  const targets: ViewportSnapTarget[] = [
    { axis: "x", value: 0, kind: "composition", id: "composition-left" },
    {
      axis: "x",
      value: compositionSize[0] * 0.5,
      kind: "composition",
      id: "composition-center-x",
    },
    { axis: "x", value: compositionSize[0], kind: "composition", id: "composition-right" },
    { axis: "y", value: 0, kind: "composition", id: "composition-top" },
    {
      axis: "y",
      value: compositionSize[1] * 0.5,
      kind: "composition",
      id: "composition-center-y",
    },
    { axis: "y", value: compositionSize[1], kind: "composition", id: "composition-bottom" },
  ];
  for (const [index, value] of (guides.vertical ?? []).entries())
    targets.push({ axis: "x", value, kind: "guide", id: `vertical-guide-${index}` });
  for (const [index, value] of (guides.horizontal ?? []).entries())
    targets.push({ axis: "y", value, kind: "guide", id: `horizontal-guide-${index}` });
  for (const bounds of layerBounds) {
    targets.push(
      { axis: "x", value: bounds.left, kind: "layer", id: `${bounds.id}-left` },
      {
        axis: "x",
        value: (bounds.left + bounds.right) * 0.5,
        kind: "layer",
        id: `${bounds.id}-center-x`,
      },
      { axis: "x", value: bounds.right, kind: "layer", id: `${bounds.id}-right` },
      { axis: "y", value: bounds.top, kind: "layer", id: `${bounds.id}-top` },
      {
        axis: "y",
        value: (bounds.top + bounds.bottom) * 0.5,
        kind: "layer",
        id: `${bounds.id}-center-y`,
      },
      { axis: "y", value: bounds.bottom, kind: "layer", id: `${bounds.id}-bottom` },
    );
  }
  return targets;
}

export function snapViewportPosition(
  position: Point2,
  transform: ViewportTransform2d,
  targets: readonly ViewportSnapTarget[],
  toleranceScreenPixels: number,
  displayScale: number,
): ViewportSnapResult {
  const moved = { ...transform, position };
  const bounds = viewportTransformBounds(moved);
  const candidates = {
    x: [bounds.left, (bounds.left + bounds.right) * 0.5, bounds.right],
    y: [bounds.top, (bounds.top + bounds.bottom) * 0.5, bounds.bottom],
  };
  const tolerance = Math.max(0, toleranceScreenPixels) / Math.max(displayScale, 1e-4);
  const result: [number, number] = [position[0], position[1]];
  const snapped: ViewportSnapTarget[] = [];
  for (const [axis, component] of [
    ["x", 0],
    ["y", 1],
  ] as const) {
    let best: { target: ViewportSnapTarget; delta: number; distance: number } | undefined;
    for (const target of targets) {
      if (target.axis !== axis) continue;
      for (const candidate of candidates[axis]) {
        const delta = target.value - candidate;
        const distance = Math.abs(delta);
        if (distance <= tolerance && (!best || distance < best.distance))
          best = { target, delta, distance };
      }
    }
    if (best) {
      result[component] += best.delta;
      snapped.push(best.target);
    }
  }
  return { position: result, snapped };
}

/** Keeps pointer previews to at most one editor dispatch per animation frame. */
export class ViewportPreviewCoalescer<Value> {
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #publish: (value: Value) => void;
  #pending?: Value;
  #handle?: number;

  constructor(
    publish: (value: Value) => void,
    requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
    cancelFrame: (handle: number) => void = cancelAnimationFrame,
  ) {
    this.#publish = publish;
    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
  }

  update(value: Value): void {
    this.#pending = value;
    if (this.#handle !== undefined) return;
    this.#handle = this.#requestFrame(() => {
      this.#handle = undefined;
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending !== undefined) this.#publish(pending);
    });
  }

  flush(): void {
    if (this.#handle !== undefined) this.#cancelFrame(this.#handle);
    this.#handle = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) this.#publish(pending);
  }

  cancel(): void {
    if (this.#handle !== undefined) this.#cancelFrame(this.#handle);
    this.#handle = undefined;
    this.#pending = undefined;
  }
}

function rotate(point: Point2, degrees: number): Point2 {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine];
}

function safeScale(value: number): number {
  if (Math.abs(value) >= 1e-6) return value;
  return value < 0 ? -1e-6 : 1e-6;
}

function resizeHandlePoint(handle: ViewportResizeHandle, size: Point2): Point2 {
  const x =
    handle.includes("West") || handle === "west"
      ? 0
      : handle.includes("East") || handle === "east"
        ? size[0]
        : size[0] * 0.5;
  const y = handle.includes("north") ? 0 : handle.includes("south") ? size[1] : size[1] * 0.5;
  return [x, y];
}

function oppositeResizeHandle(handle: ViewportResizeHandle): ViewportResizeHandle {
  return {
    northWest: "southEast",
    north: "south",
    northEast: "southWest",
    east: "west",
    southEast: "northWest",
    south: "north",
    southWest: "northEast",
    west: "east",
  }[handle] as ViewportResizeHandle;
}

function handleHasHorizontalAxis(handle: ViewportResizeHandle): boolean {
  return handle !== "north" && handle !== "south";
}

function handleHasVerticalAxis(handle: ViewportResizeHandle): boolean {
  return handle !== "east" && handle !== "west";
}

function boundedSignedScale(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum;
  if (Math.abs(value) >= minimum) return value;
  return value < 0 ? -minimum : minimum;
}
