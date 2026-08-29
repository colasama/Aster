import { describe, expect, it } from "vitest";
import type { ParsedPsdDocument } from "./psd";
import { planPsdImport } from "./psd-composition";

function fixture(): ParsedPsdDocument {
  return {
    width: 1920,
    height: 1080,
    channelCount: 4,
    depth: 8,
    colorMode: "rgb",
    mergedAlpha: true,
    composite: new Uint8ClampedArray(1920 * 1080 * 4),
    layers: [
      {
        id: 42,
        name: "Title",
        rectangle: { left: 100, top: 200, right: 500, bottom: 300 },
        width: 400,
        height: 100,
        opacity: 0.5,
        visible: true,
        blendMode: "scrn",
        pixels: new Uint8ClampedArray(400 * 100 * 4),
      },
      {
        id: 42,
        name: "Outside",
        rectangle: { left: -20, top: 1000, right: 100, bottom: 1200 },
        width: 120,
        height: 200,
        opacity: 1,
        visible: false,
        blendMode: "diff",
        pixels: new Uint8ClampedArray(120 * 200 * 4),
      },
    ],
  };
}

describe("PSD composition import plans", () => {
  it("matches AE Composition semantics without allocating document-sized copies", () => {
    const document = fixture();
    const plan = planPsdImport(document, "composition", "Cards");
    expect(plan).toMatchObject({ mode: "composition", name: "Cards", width: 1920, height: 1080 });
    expect(plan.layers[0]).toMatchObject({
      key: "layer-42",
      sourceSize: [1920, 1080],
      pixelOrigin: [100, 200],
      pixelCrop: [0, 0, 400, 100],
      position: [960, 540],
      anchor: [960, 540],
      opacity: 0.5,
      blendMode: "screen",
    });
    expect(plan.layers[0]?.pixels).toBe(document.layers[0]?.pixels);
    expect(plan.layers[1]).toMatchObject({
      key: "layer-42-2",
      pixelOrigin: [-20, 1000],
      pixelCrop: [20, 0, 100, 80],
      visible: false,
      blendMode: "normal",
      originalBlendMode: "diff",
    });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatchObject({ code: "unsupportedBlendMode", layerName: "Outside" });
  });

  it("matches AE Retain Layer Sizes anchor and position semantics", () => {
    const document = fixture();
    const plan = planPsdImport(document, "compositionRetainLayerSizes");
    expect(plan.layers[0]).toMatchObject({
      sourceSize: [400, 100],
      pixelOrigin: [0, 0],
      position: [300, 250],
      anchor: [200, 50],
    });
    expect(plan.layers[1]).toMatchObject({
      sourceSize: [120, 200],
      position: [40, 1100],
      anchor: [60, 100],
    });
    const outside = fixture();
    const outsideLayer = outside.layers[0];
    if (!outsideLayer) throw new Error("Expected a PSD layer");
    outsideLayer.rectangle = { left: 2000, top: 10, right: 2100, bottom: 110 };
    outsideLayer.width = 100;
    expect(planPsdImport(outside, "composition").layers[0]?.pixelCrop).toEqual([0, 0, 0, 100]);
  });

  it("uses the decoded composite for merged footage and fails when it is absent", () => {
    const document = fixture();
    const plan = planPsdImport(document, "merged", "Merged Card");
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]).toMatchObject({
      key: "merged",
      sourceSize: [1920, 1080],
      position: [960, 540],
      anchor: [960, 540],
    });
    expect(plan.layers[0]?.pixels).toBe(document.composite);
    expect(() => planPsdImport({ ...document, composite: undefined }, "merged")).toThrow(
      "merged composite",
    );
  });
});
