import { describe, expect, it } from "vitest";
import { applyOperations } from "../editing/operations";
import { createLayerForComposition } from "../layers/layer-factory";
import { fontFamilyNames } from "../layers/text-style";
import type { Composition, Layer, Project } from "../types";
import { findMissingFontFamilies, fontReplacementOperations } from "./missing-fonts";
import { createBlankComposition, createBlankProject } from "./project";

function textLayer(composition: Composition, fontFamily: string, locked = false): Layer {
  const layer = createLayerForComposition("text", composition);
  if (!layer.textStyle) throw new Error("text layers carry a style");
  return { ...layer, locked, textStyle: { ...layer.textStyle, fontFamily } };
}

function fixture(): Project {
  const project = createBlankProject();
  const main = project.compositions[0];
  const second = createBlankComposition("Lyrics");
  main.layers = [
    textLayer(main, "Noto Serif SC"),
    textLayer(main, "Noto Serif SC", true),
    textLayer(main, 'Inter, "Segoe UI", sans-serif'),
    textLayer(main, '"Missing Brand", "Also Missing"'),
  ];
  second.layers = [textLayer(second, "Noto Serif SC"), textLayer(second, "Georgia")];
  project.compositions.push(second);
  return project;
}

const installed = new Set(["georgia", "segoe ui", "source han serif sc"]);
const isAvailable = (family: string) =>
  installed.has(family.toLowerCase()) || family === "sans-serif";

describe("fontFamilyNames", () => {
  it("splits quoted CSS family lists", () => {
    expect(fontFamilyNames(`"Brand, Display" , 'Noto  Serif SC',serif`)).toEqual([
      "Brand, Display",
      "Noto Serif SC",
      "serif",
    ]);
    expect(fontFamilyNames("  ")).toEqual([]);
  });
});

describe("findMissingFontFamilies", () => {
  it("reports families with no available entry across every composition", () => {
    expect(findMissingFontFamilies(fixture(), isAvailable)).toEqual([
      { family: "Noto Serif SC", layerCount: 3 },
      { family: '"Missing Brand", "Also Missing"', layerCount: 1 },
    ]);
  });
});

describe("fontReplacementOperations", () => {
  it("retargets locked and inactive-composition layers as one valid transaction", () => {
    const project = fixture();
    const operations = fontReplacementOperations(
      project,
      new Map([["Noto Serif SC", '"Source Han Serif SC"']]),
    );
    const next = applyOperations(project, operations);
    const families = next.compositions.flatMap((composition) =>
      composition.layers.map((layer) => [layer.textStyle?.fontFamily, layer.locked]),
    );
    expect(families).toEqual([
      ['"Source Han Serif SC"', false],
      ['"Source Han Serif SC"', true],
      ['Inter, "Segoe UI", sans-serif', false],
      ['"Missing Brand", "Also Missing"', false],
      ['"Source Han Serif SC"', false],
      ["Georgia", false],
    ]);
    expect(next.activeCompositionId).toBe(project.activeCompositionId);
    expect(findMissingFontFamilies(next, isAvailable)).toEqual([
      { family: '"Missing Brand", "Also Missing"', layerCount: 1 },
    ]);
  });

  it("emits nothing when no replacement applies", () => {
    expect(fontReplacementOperations(fixture(), new Map([["Absent", "Georgia"]]))).toEqual([]);
  });
});
