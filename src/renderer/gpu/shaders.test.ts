import { describe, expect, it } from "vitest";
import { postProcessShader } from "./shaders";

describe("post-process shader", () => {
  it("keeps sample_blur free of implicit-LOD sampling", () => {
    const body = postProcessShader.match(/fn sample_blur[\s\S]*?\n\}/)?.[0];
    expect(body).toBeDefined();
    // Callers may pass a per-pixel radius (non-uniform control flow), so Dawn
    // rejects textureSample inside this function; every sample must pin the LOD.
    expect(body).not.toMatch(/\btextureSample\(/);
  });
});
