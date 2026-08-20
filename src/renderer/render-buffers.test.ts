import { describe, expect, it } from "vitest";
import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  buildBufferVisualizationUniforms,
  encodeRenderId,
  planAuxiliaryBuffers,
  SCENE_BUFFER_VISUALIZATIONS,
  visualizationCode,
} from "./render-buffers";

describe("auxiliary render buffers", () => {
  it("exposes only scene buffers that the viewport can render truthfully", () => {
    expect(SCENE_BUFFER_VISUALIZATIONS).toEqual(["beauty", "linearColor", "luminance", "alpha"]);
  });

  it("plans typed GPU attachments within an explicit budget", () => {
    const plan = planAuxiliaryBuffers(1920, 1080);
    expect(plan.attachments.map(({ kind }) => kind)).toEqual([
      "normal",
      "objectId",
      "materialId",
      "worldPosition",
    ]);
    expect(plan.estimatedBytes).toBe(1920 * 1080 * 24);
    expect(AUXILIARY_BUFFER_DESCRIPTORS.objectId.format).toBe("r32uint");
    expect(AUXILIARY_BUFFER_DESCRIPTORS.normal.format).toBe("rgba16float");
  });

  it("deduplicates requests and refuses allocations over budget", () => {
    expect(planAuxiliaryBuffers(10, 10, ["normal", "normal"]).estimatedBytes).toBe(800);
    expect(() => planAuxiliaryBuffers(4096, 4096, undefined, 16 * 1024 * 1024)).toThrow(
      "exceeding",
    );
  });

  it("encodes stable non-zero object and material identifiers", () => {
    expect(encodeRenderId("layer:hero")).toBe(encodeRenderId("layer:hero"));
    expect(encodeRenderId("layer:hero")).not.toBe(encodeRenderId("material:hero"));
    expect(encodeRenderId("")).not.toBe(0);
  });

  it("packs deterministic debug selection and position ranges", () => {
    expect(visualizationCode("normal")).toBe(1);
    expect(visualizationCode("worldPosition")).toBe(4);
    const uniforms = buildBufferVisualizationUniforms("worldPosition", [-20, 80]);
    expect([...uniforms.slice(0, 2)]).toEqual([4, -20]);
    expect(uniforms[2]).toBeCloseTo(0.01);
    expect(uniforms[3]).toBe(0);
  });
});
