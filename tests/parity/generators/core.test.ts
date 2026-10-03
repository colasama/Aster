import { describe, expect, it } from "vitest";
import { validateProjectDocument } from "../../../src/core/project/validation/document";
import { ANTI_ALIASING_MODES } from "../../../src/core/rendering/anti-aliasing";
import { BLEND_MODES } from "../../../src/core/types";
import { caseFor, fixture } from "./base";
import { buildCoreCases } from "./core";

describe("deterministic parity core fixtures", () => {
  it("uses the product factories while keeping stack ownership explicit", () => {
    const value = fixture("empty");
    const layer = value.layer("shape", "Shape witness");
    expect(value.composition.layers).toEqual([]);
    expect(layer.name).toBe("Shape witness");
    expect(layer.outPoint).toBe(2);
    expect(value.composition.width).toBe(320);
    expect(value.composition.height).toBe(180);
  });

  it("remaps references and object keys consistently without changing the input", () => {
    const value = fixture("references");
    const parent = value.layer("null");
    const child = value.layer("shape");
    child.parentId = parent.id;
    value.composition.layers = [child, parent];
    const folder = { id: crypto.randomUUID(), name: "Witnesses" };
    value.project.folders.push(folder);
    value.project.itemFolderIds[child.id] = folder.id;
    const before = JSON.stringify(value.project);
    const result = caseFor("references", value.project, ["layer:null"]);
    const stableChild = result.project.compositions[0].layers[0];
    const stableParent = result.project.compositions[0].layers[1];
    expect(stableChild.id).not.toBe(child.id);
    expect(stableChild.parentId).toBe(stableParent.id);
    expect(result.project.itemFolderIds[stableChild.id]).toBe(result.project.folders[0].id);
    expect(result.case.composition).toBe(result.project.activeCompositionId);
    expect(JSON.stringify(value.project)).toBe(before);
  });

  it("generates identical schema-valid projects across fresh random factory IDs", () => {
    const first = buildCoreCases();
    expect(buildCoreCases()).toEqual(first);
    for (const entry of first) {
      expect(() => validateProjectDocument(entry.project), entry.case.id).not.toThrow();
      expect(entry.project.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("exercises actual blend modes and AA settings rather than feature labels alone", () => {
    const cases = buildCoreCases();
    for (const mode of BLEND_MODES) {
      const entry = cases.find((item) => item.case.id === `blend-${mode}`);
      expect(entry?.project.compositions[0].layers[0].blendMode).toBe(mode);
      expect(entry?.project.compositions[0].layers.length).toBeGreaterThan(1);
    }
    expect(
      cases.filter((item) => item.case.id.startsWith("aa-")).map((item) => item.case.aa),
    ).toEqual([...ANTI_ALIASING_MODES]);
  });

  it("links two nested composition levels and leaves the effect surface explicit", () => {
    const entry = buildCoreCases().find((item) => item.case.id === "nested-precompositions");
    expect(entry).toBeDefined();
    if (!entry) return;
    const [outer, middle, inner] = entry.project.compositions;
    expect(outer.layers[0].sourceCompositionId).toBe(middle.id);
    expect(middle.layers[0].sourceCompositionId).toBe(inner.id);
    expect(inner.layers[0].kind).toBe("shape");
    expect(outer.layers[0].effects[0].enabled).toBe(true);
  });
});
