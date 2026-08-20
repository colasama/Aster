import { describe, expect, it } from "vitest";
import { PARTICLE_INDIRECT_RESET, particleIntersectsClipSpace } from "./particle-indirect";
import { particleComputeShader } from "./shaders";

describe("GPU particle indirect culling", () => {
  it("resets a six-vertex indirect draw before GPU compaction", () => {
    expect([...PARTICLE_INDIRECT_RESET]).toEqual([6, 0, 0, 0]);
  });

  it("retains billboards intersecting clip space and rejects distant particles", () => {
    expect(particleIntersectsClipSpace(1.01, 0, 18)).toBe(true);
    expect(particleIntersectsClipSpace(1.1, 0, 18)).toBe(false);
    expect(particleIntersectsClipSpace(0, -1.2, 2)).toBe(false);
  });

  it("atomically compacts visible particles into the indirect instance range", () => {
    expect(particleComputeShader).toContain("instance_count: atomic<u32>");
    expect(particleComputeShader).toContain("atomicAdd(&particle_draw.instance_count, 1u)");
    expect(particleComputeShader).toContain("particles[visible_index]");
  });
});
