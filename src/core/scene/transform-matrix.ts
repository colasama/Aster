import type { EvaluatedTransform } from "../types";

/** Column-major affine matrices; no decomposition loses shear from nested nonuniform scales. */
export type Matrix4 = readonly number[];
export const IDENTITY_MATRIX: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiplyMatrices(a: Matrix4, b: Matrix4): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

export function transformPoint(m: Matrix4, p: readonly number[], w = 1): [number, number, number] {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * w) as [
    number,
    number,
    number,
  ];
}

export function transformMatrix(t: EvaluatedTransform): number[] {
  const [x, y, z] = t.rotation.map((v) => (v * Math.PI) / 180);
  const [sx, sy, sz] = t.scale.map((v) => v / 100);
  const cx = Math.cos(x),
    cy = Math.cos(y),
    cz = Math.cos(z);
  const ax = Math.sin(x),
    ay = Math.sin(y),
    az = Math.sin(z);
  const m = [
    cz * cy * sx,
    az * cy * sx,
    -ay * sx,
    0,
    (cz * ay * ax - az * cx) * sy,
    (az * ay * ax + cz * cx) * sy,
    cy * ax * sy,
    0,
    (cz * ay * cx + az * ax) * sz,
    (az * ay * cx - cz * ax) * sz,
    cy * cx * sz,
    0,
    0,
    0,
    0,
    1,
  ];
  const anchor = transformPoint(m, t.anchor, 0);
  for (let i = 0; i < 3; i++) m[12 + i] = t.position[i] - anchor[i];
  return m;
}

export function invertAffine(m: Matrix4): number[] | undefined {
  const a = m[0],
    b = m[4],
    c = m[8],
    d = m[1],
    e = m[5],
    f = m[9],
    g = m[2],
    h = m[6],
    i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return undefined;
  const out = [
    (e * i - f * h) / det,
    (f * g - d * i) / det,
    (d * h - e * g) / det,
    0,
    (c * h - b * i) / det,
    (a * i - c * g) / det,
    (b * g - a * h) / det,
    0,
    (b * f - c * e) / det,
    (c * d - a * f) / det,
    (a * e - b * d) / det,
    0,
    0,
    0,
    0,
    1,
  ];
  const translation = transformPoint(out, [m[12], m[13], m[14]], 0);
  for (let axis = 0; axis < 3; axis++) out[12 + axis] = -translation[axis];
  return out;
}
