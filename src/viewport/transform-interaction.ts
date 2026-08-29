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
