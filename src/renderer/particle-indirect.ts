import { particleVertexCount } from "./particle-mesh";

export const PARTICLE_INDIRECT_RESET = new Uint32Array([particleVertexCount("billboard"), 0, 0, 0]);
export const PARTICLE_MESH_INDIRECT_RESET = new Uint32Array([particleVertexCount("mesh"), 0, 0, 0]);

export function particleIndirectReset(renderMode: "billboard" | "mesh"): Uint32Array {
  return renderMode === "mesh" ? PARTICLE_MESH_INDIRECT_RESET : PARTICLE_INDIRECT_RESET;
}

export function particleIntersectsClipSpace(x: number, y: number, sizePixels: number): boolean {
  const margin = Math.max(0, sizePixels) / 900;
  return Math.abs(x) <= 1 + margin && Math.abs(y) <= 1 + margin;
}
