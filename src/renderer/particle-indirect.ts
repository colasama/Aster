export const PARTICLE_INDIRECT_RESET = new Uint32Array([6, 0, 0, 0]);

export function particleIntersectsClipSpace(x: number, y: number, sizePixels: number): boolean {
  const margin = Math.max(0, sizePixels) / 900;
  return Math.abs(x) <= 1 + margin && Math.abs(y) <= 1 + margin;
}
