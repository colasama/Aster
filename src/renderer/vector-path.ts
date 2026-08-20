import type { BezierPath } from "../core/types";

export type Point2 = [number, number];

const EPSILON = 1e-7;

export function createDefaultBezierPath(): BezierPath {
  return {
    closed: false,
    vertices: [
      { position: [-0.5, 0.25], inTangent: [0, 0], outTangent: [0.28, -0.5] },
      { position: [0.5, -0.25], inTangent: [-0.28, 0.5], outTangent: [0, 0] },
    ],
  };
}

export function flattenBezierPath(path: BezierPath, tolerance = 0.002): Point2[] {
  if (path.vertices.length < 2) return path.vertices.map((vertex) => [...vertex.position]);
  const points: Point2[] = [[...path.vertices[0].position]];
  const segmentCount = path.closed ? path.vertices.length : path.vertices.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = path.vertices[index];
    const end = path.vertices[(index + 1) % path.vertices.length];
    flattenCubic(
      start.position,
      add(start.position, start.outTangent),
      add(end.position, end.inTangent),
      end.position,
      tolerance * tolerance,
      points,
      0,
    );
  }
  if (path.closed && distanceSquared(points[0], points[points.length - 1]) <= EPSILON) points.pop();
  return removeAdjacentDuplicates(points);
}

export function triangulatePolygon(source: Point2[]): Point2[] {
  const points = removeAdjacentDuplicates(source);
  if (points.length < 3) return [];
  const orientation = signedArea(points) >= 0 ? 1 : -1;
  const indices = points.map((_, index) => index);
  const triangles: Point2[] = [];
  let guard = points.length * points.length;
  while (indices.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let cursor = 0; cursor < indices.length; cursor += 1) {
      const previous = indices[(cursor + indices.length - 1) % indices.length];
      const current = indices[cursor];
      const next = indices[(cursor + 1) % indices.length];
      if (cross(points[previous], points[current], points[next]) * orientation <= EPSILON) continue;
      if (
        indices.some(
          (candidate) =>
            candidate !== previous &&
            candidate !== current &&
            candidate !== next &&
            pointInTriangle(points[candidate], points[previous], points[current], points[next]),
        )
      )
        continue;
      triangles.push(points[previous], points[current], points[next]);
      indices.splice(cursor, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (indices.length === 3) triangles.push(...indices.map((index) => points[index]));
  return triangles;
}

export function tessellateStroke(
  source: Point2[],
  width: number,
  closed: boolean,
  join: "miter" | "bevel" | "round",
  cap: "butt" | "round",
): Point2[] {
  const points = removeAdjacentDuplicates(source);
  if (points.length < 2 || width <= 0) return [];
  const half = width / 2;
  const segmentCount = closed ? points.length : points.length - 1;
  const directions: Point2[] = [];
  const normals: Point2[] = [];
  const triangles: Point2[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const direction = normalize([end[0] - start[0], end[1] - start[1]]);
    const normal: Point2 = [-direction[1] * half, direction[0] * half];
    directions.push(direction);
    normals.push(normal);
    const a = add(start, normal);
    const b = subtract(start, normal);
    const c = add(end, normal);
    const d = subtract(end, normal);
    triangles.push(a, b, c, c, b, d);
  }

  const joinStart = closed ? 0 : 1;
  const joinEnd = closed ? points.length : points.length - 1;
  for (let index = joinStart; index < joinEnd; index += 1) {
    const previous = (index + segmentCount - 1) % segmentCount;
    const next = index % segmentCount;
    appendJoin(
      triangles,
      points[index % points.length],
      directions[previous],
      directions[next],
      normals[previous],
      normals[next],
      half,
      join,
    );
  }
  if (!closed && cap === "round") {
    appendRoundCap(triangles, points[0], directions[0], half, true);
    appendRoundCap(
      triangles,
      points[points.length - 1],
      directions[directions.length - 1],
      half,
      false,
    );
  }
  return triangles;
}

function flattenCubic(
  p0: Point2,
  p1: Point2,
  p2: Point2,
  p3: Point2,
  toleranceSquared: number,
  output: Point2[],
  depth: number,
): void {
  if (
    depth >= 12 ||
    Math.max(pointLineDistanceSquared(p1, p0, p3), pointLineDistanceSquared(p2, p0, p3)) <=
      toleranceSquared
  ) {
    output.push([...p3]);
    return;
  }
  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const center = midpoint(p012, p123);
  flattenCubic(p0, p01, p012, center, toleranceSquared, output, depth + 1);
  flattenCubic(center, p123, p23, p3, toleranceSquared, output, depth + 1);
}

function appendJoin(
  output: Point2[],
  center: Point2,
  previousDirection: Point2,
  nextDirection: Point2,
  previousNormal: Point2,
  nextNormal: Point2,
  half: number,
  join: "miter" | "bevel" | "round",
): void {
  const turn = previousDirection[0] * nextDirection[1] - previousDirection[1] * nextDirection[0];
  if (Math.abs(turn) <= EPSILON) return;
  const side = turn > 0 ? 1 : -1;
  const previousOuter = add(center, scale(previousNormal, side));
  const nextOuter = add(center, scale(nextNormal, side));
  if (join === "bevel") {
    output.push(center, previousOuter, nextOuter);
    return;
  }
  if (join === "miter") {
    const miter = normalize([
      (previousNormal[0] + nextNormal[0]) * side,
      (previousNormal[1] + nextNormal[1]) * side,
    ]);
    const nextUnit = scale(nextNormal, side / half);
    const denominator = Math.max(0.25, miter[0] * nextUnit[0] + miter[1] * nextUnit[1]);
    const miterPoint = add(center, scale(miter, Math.min(half * 4, half / denominator)));
    output.push(previousOuter, miterPoint, nextOuter);
    return;
  }
  const startAngle = Math.atan2(previousOuter[1] - center[1], previousOuter[0] - center[0]);
  let endAngle = Math.atan2(nextOuter[1] - center[1], nextOuter[0] - center[0]);
  if (turn > 0 && endAngle < startAngle) endAngle += Math.PI * 2;
  if (turn < 0 && endAngle > startAngle) endAngle -= Math.PI * 2;
  const steps = Math.max(1, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 8)));
  let previous = previousOuter;
  for (let step = 1; step <= steps; step += 1) {
    const angle = startAngle + ((endAngle - startAngle) * step) / steps;
    const next: Point2 = [center[0] + Math.cos(angle) * half, center[1] + Math.sin(angle) * half];
    output.push(center, previous, next);
    previous = next;
  }
}

function appendRoundCap(
  output: Point2[],
  center: Point2,
  direction: Point2,
  radius: number,
  start: boolean,
): void {
  const outward = start
    ? Math.atan2(-direction[1], -direction[0])
    : Math.atan2(direction[1], direction[0]);
  let previous: Point2 = [
    center[0] + Math.cos(outward - Math.PI / 2) * radius,
    center[1] + Math.sin(outward - Math.PI / 2) * radius,
  ];
  for (let step = 1; step <= 8; step += 1) {
    const angle = outward - Math.PI / 2 + (Math.PI * step) / 8;
    const next: Point2 = [
      center[0] + Math.cos(angle) * radius,
      center[1] + Math.sin(angle) * radius,
    ];
    output.push(center, previous, next);
    previous = next;
  }
}

function pointInTriangle(point: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const first = cross(a, b, point);
  const second = cross(b, c, point);
  const third = cross(c, a, point);
  return (
    (first >= -EPSILON && second >= -EPSILON && third >= -EPSILON) ||
    (first <= EPSILON && second <= EPSILON && third <= EPSILON)
  );
}

function pointLineDistanceSquared(point: Point2, start: Point2, end: Point2): number {
  const length = distanceSquared(start, end);
  if (length <= EPSILON) return distanceSquared(point, start);
  const amount = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * (end[0] - start[0]) + (point[1] - start[1]) * (end[1] - start[1])) /
        length,
    ),
  );
  return distanceSquared(point, [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
  ]);
}

function removeAdjacentDuplicates(points: Point2[]): Point2[] {
  return points.filter(
    (point, index) => index === 0 || distanceSquared(point, points[index - 1]) > EPSILON,
  );
}

function signedArea(points: Point2[]): number {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0);
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function normalize(point: Point2): Point2 {
  const length = Math.hypot(...point);
  return length <= EPSILON ? [1, 0] : [point[0] / length, point[1] / length];
}

function midpoint(a: Point2, b: Point2): Point2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function add(a: Point2, b: Point2): Point2 {
  return [a[0] + b[0], a[1] + b[1]];
}

function subtract(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function scale(point: Point2, amount: number): Point2 {
  return [point[0] * amount, point[1] * amount];
}

function distanceSquared(a: Point2, b: Point2): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
