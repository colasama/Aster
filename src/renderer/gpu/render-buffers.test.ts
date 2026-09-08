import { describe, expect, it } from "vitest";
import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  auxiliaryRenderPassBytes,
  BUFFER_VISUALIZATIONS,
  buildBufferVisualizationUniforms,
  encodeRenderId,
  planAuxiliaryBuffers,
  postRenderRoute,
  SCENE_BUFFER_VISUALIZATIONS,
  supportsAuxiliaryMrt,
  visualizationCode,
} from "./render-buffers";

describe("auxiliary render buffers", () => {
  it("exposes only scene buffers that the viewport can render truthfully", () => {
    expect(SCENE_BUFFER_VISUALIZATIONS).toEqual(["beauty", "linearColor", "luminance", "alpha"]);
    expect(BUFFER_VISUALIZATIONS).toEqual([
      "beauty",
      "linearColor",
      "luminance",
      "alpha",
      "depthFog",
      "depthOfField",
      "selectionIsolation",
      "vectorMotionBlur",
      "normal",
      "objectId",
      "materialId",
      "worldPosition",
      "motionVector",
    ]);
  });

  it("plans typed GPU attachments within an explicit budget", () => {
    const plan = planAuxiliaryBuffers(1920, 1080);
    expect(plan.attachments.map(({ kind }) => kind)).toEqual([
      "normal",
      "objectId",
      "materialId",
      "worldPosition",
      "motionVector",
    ]);
    expect(plan.estimatedBytes).toBe(1920 * 1080 * 28);
    expect(auxiliaryRenderPassBytes(plan)).toBe(1920 * 1080 * 32);
    expect(AUXILIARY_BUFFER_DESCRIPTORS.objectId.format).toBe("r32uint");
    expect(AUXILIARY_BUFFER_DESCRIPTORS.normal.format).toBe("rgba16float");
    expect(AUXILIARY_BUFFER_DESCRIPTORS.motionVector.format).toBe("rg16float");
  });

  it("deduplicates requests and refuses allocations over budget", () => {
    expect(planAuxiliaryBuffers(10, 10, ["normal", "normal"]).estimatedBytes).toBe(800);
    expect(() => planAuxiliaryBuffers(4096, 4096, undefined, 16 * 1024 * 1024)).toThrow(
      "exceeding",
    );
  });

  it("requires enough MRT slots and bytes for the motion attachment", () => {
    expect(
      supportsAuxiliaryMrt({
        maxColorAttachments: 5,
        maxColorAttachmentBytesPerSample: 28,
      } as GPUSupportedLimits),
    ).toBe(true);
    expect(
      supportsAuxiliaryMrt({
        maxColorAttachments: 4,
        maxColorAttachmentBytesPerSample: 28,
      } as GPUSupportedLimits),
    ).toBe(false);
    expect(
      supportsAuxiliaryMrt({
        maxColorAttachments: 5,
        maxColorAttachmentBytesPerSample: 24,
      } as GPUSupportedLimits),
    ).toBe(false);
  });

  it("encodes stable non-zero object and material identifiers", () => {
    expect(encodeRenderId("layer:hero")).toBe(encodeRenderId("layer:hero"));
    expect(encodeRenderId("layer:hero")).not.toBe(encodeRenderId("material:hero"));
    expect(encodeRenderId("")).not.toBe(0);
  });

  it("packs deterministic debug selection and position ranges", () => {
    expect(visualizationCode("normal")).toBe(1);
    expect(visualizationCode("worldPosition")).toBe(4);
    expect(visualizationCode("motionVector")).toBe(5);
    const uniforms = buildBufferVisualizationUniforms("worldPosition", [-20, 80]);
    expect([...uniforms.slice(0, 2)]).toEqual([4, -20]);
    expect(uniforms[2]).toBeCloseTo(0.01);
    expect(uniforms[3]).toBe(0);
  });

  it("routes an invalid surface-data frame through the safe Beauty post", () => {
    expect(postRenderRoute("selectionIsolation", true)).toBe("surface");
    expect(postRenderRoute("vectorMotionBlur", true)).toBe("surface");
    expect(postRenderRoute("selectionIsolation", false)).toBe("beauty");
    expect(postRenderRoute("vectorMotionBlur", false)).toBe("beauty");
    expect(postRenderRoute("beauty", false)).toBe("beauty");
    expect(postRenderRoute("normal", true)).toBe("visualizer");
  });
});
