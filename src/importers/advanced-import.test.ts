// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { createBlankProject } from "../core/project";
import { createImageSequenceImport, createPsdImport, createSvgImport } from "./advanced-import";
import { detectImageSequence } from "./image-sequence";
import { mediaImportRuntime, type RuntimeSequenceFile } from "./media-import-runtime";
import type { ParsedPsdDocument } from "./psd";

afterEach(() => mediaImportRuntime.clear());

describe("advanced media import wiring", () => {
  it("keeps sanitized SVG vector markup outside the project snapshot", () => {
    const composition = createBlankProject().compositions[0];
    const imported = createSvgImport(
      {
        width: 640,
        height: 360,
        viewBox: [0, 0, 640, 360],
        sanitized: '<svg viewBox="0 0 640 360"><path d="M0 0h10v10z"/></svg>',
        nodeCount: 2,
      },
      "mark.svg",
      composition,
      1,
    );
    const source = imported.sources[0];
    expect(source).toMatchObject({ kind: "svg", width: 640, height: 360 });
    expect(source?.dataUrl).toBeUndefined();
    expect(imported.layers[0]).toMatchObject({ kind: "image", size: [640, 360], inPoint: 1 });
    expect(source && mediaImportRuntime.get(source.id)).toMatchObject({
      kind: "svg",
      parsed: { nodeCount: 2 },
    });
  });

  it("creates distinct PSD composition and retain-layer-size source semantics", () => {
    const composition = createBlankProject().compositions[0];
    const document = psdDocument();
    const full = createPsdImport(document, "composition", "design.psd", "psd:test", composition, 0);
    const retained = createPsdImport(
      document,
      "compositionRetainLayerSizes",
      "design.psd",
      "psd:test",
      composition,
      0,
    );
    expect(full.composition).toMatchObject({ name: "design", width: 100, height: 80 });
    expect(full.sources[0]).toMatchObject({ kind: "psd", width: 100, height: 80 });
    expect(retained.sources[0]).toMatchObject({ kind: "psd", width: 40, height: 30 });
    expect(full.layers[0]?.transform.position.slice(0, 2)).toEqual([
      { mode: "static", value: 30 },
      { mode: "static", value: 35 },
    ]);
    const runtime = full.sources[0] && mediaImportRuntime.get(full.sources[0].id);
    expect(runtime).toMatchObject({ kind: "psd", crop: [0, 0, 40, 30] });
    expect(runtime?.kind === "psd" && runtime.pixels).toBe(document.layers[0]?.pixels);
  });

  it("adds merged PSD footage to the active composition", () => {
    const composition = createBlankProject().compositions[0];
    const imported = createPsdImport(
      psdDocument(),
      "merged",
      "design.psd",
      "psd:test",
      composition,
      2,
    );
    expect(imported.composition).toBeUndefined();
    expect(imported.sources).toHaveLength(1);
    expect(imported.layers[0]).toMatchObject({ inPoint: 2, size: [100, 80] });
  });

  it("preserves exact sequence rate and missing-frame policy for time-addressed decode", () => {
    const composition = createBlankProject().compositions[0];
    const frames = [sequenceFile("shot.0001.png"), sequenceFile("shot.0003.png")];
    const input = { selection: detectImageSequence(frames, "shot.0001.png") };
    const imported = createImageSequenceImport(
      input,
      [1920, 1080],
      {
        frameRate: { numerator: 24_000, denominator: 1_001 },
        missingFramePolicy: "nearest",
      },
      composition,
      0,
    );
    const source = imported.sources[0];
    expect(source).toMatchObject({
      kind: "imageSequence",
      pattern: "shot.[####].png",
      startFrame: 1,
      endFrame: 3,
      interpretation: { frameRate: { numerator: 24_000, denominator: 1_001 } },
    });
    expect(imported.warnings).toHaveLength(1);
    expect(imported.layers[0]?.outPoint).toBeCloseTo((3 * 1_001) / 24_000);
    expect(source && mediaImportRuntime.get(source.id)).toMatchObject({
      kind: "imageSequence",
      missingFramePolicy: "nearest",
    });
  });
});

function psdDocument(): ParsedPsdDocument {
  return {
    width: 100,
    height: 80,
    channelCount: 4,
    depth: 8,
    colorMode: "rgb",
    mergedAlpha: true,
    layers: [
      {
        id: 7,
        name: "Logo",
        rectangle: { left: 10, top: 20, right: 50, bottom: 50 },
        width: 40,
        height: 30,
        opacity: 0.75,
        visible: true,
        blendMode: "norm",
        pixels: new Uint8ClampedArray(40 * 30 * 4).fill(255),
      },
    ],
    composite: new Uint8ClampedArray(100 * 80 * 4).fill(255),
  };
}

function sequenceFile(name: string): RuntimeSequenceFile {
  return { name, size: 4, lastModified: 1, type: "image/png", url: `blob:${name}` };
}
