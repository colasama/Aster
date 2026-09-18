import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { planPrecomposition } from "../project/precomposition";
import {
  activeComposition,
  createBlankComposition,
  createBlankProject,
  createDemoProject,
} from "../project/project";
import { applyOperations } from "./operations";

describe("project operations", () => {
  it("manages shared footage sources without cloning embedded bytes on unrelated edits", () => {
    const project = createBlankProject(true);
    const composition = activeComposition(project);
    const bytes = `data:image/png;base64,${"A".repeat(1024)}`;
    const source = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: "test:shared-plate",
      dataUrl: bytes,
      width: 1920,
      height: 1080,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    const first = createLayerForComposition("image", composition);
    const second = createLayerForComposition("image", composition);
    first.sourceId = source.id;
    second.sourceId = source.id;
    const imported = applyOperations(project, [
      { type: "addSource", source },
      { type: "addLayer", layer: first },
      { type: "addLayer", layer: second },
    ]);
    expect(imported.sources[0].dataUrl).toBe(bytes);
    expect(imported.compositions[0].layers.slice(0, 2).map((layer) => layer.sourceId)).toEqual([
      source.id,
      source.id,
    ]);

    const renamed = applyOperations(imported, [
      { type: "renameLayer", layerId: first.id, name: "Plate instance" },
    ]);
    expect(renamed.sources[0]).toBe(imported.sources[0]);
    expect(() =>
      applyOperations(imported, [{ type: "removeSource", sourceId: source.id }]),
    ).toThrow("still reference it");

    const detached = applyOperations(imported, [
      { type: "setLayerSource", layerId: first.id },
      { type: "setLayerSource", layerId: second.id },
      { type: "cleanupOrphanSources" },
    ]);
    expect(detached.sources).toEqual([]);
  });

  it("relinks, reloads, and interprets one stable footage source", () => {
    const project = createBlankProject(true);
    const source = {
      id: crypto.randomUUID(),
      kind: "video" as const,
      name: "take.mp4",
      mimeType: "video/mp4",
      contentIdentity: "test:take-1",
      relativePath: "assets/take.mp4",
      width: 1280,
      height: 720,
      duration: 5,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    const added = applyOperations(project, [{ type: "addSource", source }]);
    const relinked = applyOperations(added, [
      {
        type: "relinkSource",
        sourceId: source.id,
        name: "take-new.mp4",
        contentIdentity: "test:take-2",
        runtimeUrl: "asset://take-new.mp4",
      },
      {
        type: "interpretSource",
        sourceId: source.id,
        interpretation: {
          alpha: "ignore",
          colorSpace: "display-p3",
          frameRate: { numerator: 24_000, denominator: 1001 },
        },
      },
    ]);
    expect(relinked.sources[0]).toMatchObject({
      name: "take-new.mp4",
      contentIdentity: "test:take-2",
      relativePath: undefined,
      runtimeUrl: "asset://take-new.mp4",
      interpretation: {
        alpha: "ignore",
        colorSpace: "display-p3",
        frameRate: { numerator: 24_000, denominator: 1001 },
      },
    });
    const current = relinked.sources[0];
    if (current.kind !== "video") throw new Error("Expected video source");
    const reloaded = applyOperations(relinked, [
      {
        type: "reloadSource",
        sourceId: source.id,
        source: { ...current, width: 1920, height: 1080, duration: 6 },
      },
    ]);
    expect(reloaded.sources[0]).toMatchObject({ width: 1920, height: 1080, duration: 6 });
  });

  it("does not mutate the source project", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const result = applyOperations(source, [
      { type: "renameLayer", layerId: layer.id, name: "Renamed" },
      { type: "setProperty", layerId: layer.id, path: "opacity", value: 42 },
    ]);
    expect(activeComposition(source).layers[0].name).toBe("ASTER");
    expect(activeComposition(result).layers[0].name).toBe("Renamed");
    expect(activeComposition(result).layers[0].transform.opacity).toEqual({
      mode: "static",
      value: 42,
    });
  });

  it("creates and edits compositions through replayable project operations", () => {
    const source = createDemoProject();
    const composition = createBlankComposition("Second");
    const result = applyOperations(source, [
      { type: "addComposition", composition, activate: true },
      {
        type: "setCompositionSettings",
        compositionId: composition.id,
        name: "Delivery",
        width: 7680,
        height: 4320,
        frameRate: { numerator: 60_000, denominator: 1001 },
        duration: 30,
      },
    ]);
    expect(result.activeCompositionId).toBe(composition.id);
    expect(activeComposition(result)).toMatchObject({
      name: "Delivery",
      width: 7680,
      height: 4320,
      frameRate: { numerator: 60_000, denominator: 1001 },
      duration: 30,
    });
    expect(source.compositions).toHaveLength(1);
    const navigated = applyOperations(result, [
      { type: "setActiveComposition", compositionId: source.activeCompositionId },
    ]);
    expect(navigated.activeCompositionId).toBe(source.activeCompositionId);
  });

  it("creates project folders and moves compositions and media between them", () => {
    const source = createBlankProject(true);
    const folder = { id: crypto.randomUUID(), name: "Footage" };
    const nestedFolder = { id: crypto.randomUUID(), name: "Selects", parentId: folder.id };
    const image = createLayerForComposition("image", activeComposition(source));
    const footage = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: "test:plate",
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    image.sourceId = footage.id;
    const organized = applyOperations(source, [
      { type: "addSource", source: footage },
      { type: "addLayer", layer: image },
      { type: "addProjectFolder", folder },
      { type: "addProjectFolder", folder: nestedFolder },
      { type: "moveProjectItem", itemId: source.activeCompositionId, folderId: folder.id },
      { type: "moveProjectItem", itemId: footage.id, folderId: nestedFolder.id },
    ]);

    expect(organized.folders).toEqual([folder, nestedFolder]);
    expect(organized.itemFolderIds).toEqual({
      [source.activeCompositionId]: folder.id,
      [footage.id]: nestedFolder.id,
    });
    const returnedToRoot = applyOperations(organized, [
      { type: "moveProjectItem", itemId: footage.id },
    ]);
    expect(returnedToRoot.itemFolderIds[footage.id]).toBeUndefined();
    expect(source.folders).toEqual([]);
  });

  it("renames each project item kind and safely moves nested folders", () => {
    const source = createDemoProject();
    const composition = source.compositions[0];
    const footage = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: "test:rename-plate",
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    expect(composition).toBeDefined();
    if (!composition) return;
    const parent = { id: crypto.randomUUID(), name: "Parent" };
    const child = { id: crypto.randomUUID(), name: "Child" };
    const renamed = applyOperations(source, [
      { type: "addProjectFolder", folder: parent },
      { type: "addProjectFolder", folder: child },
      { type: "addSource", source: footage },
      { type: "renameProjectItem", itemId: composition.id, name: "Main" },
      { type: "renameProjectItem", itemId: footage.id, name: "Plate" },
      { type: "renameProjectItem", itemId: child.id, name: "Media" },
      { type: "moveProjectFolder", folderId: child.id, parentId: parent.id },
    ]);
    expect(renamed.compositions[0]?.name).toBe("Main");
    expect(renamed.sources[0]?.name).toBe("Plate");
    expect(renamed.folders.find((folder) => folder.id === child.id)).toMatchObject({
      name: "Media",
      parentId: parent.id,
    });
    expect(() =>
      applyOperations(renamed, [
        { type: "moveProjectFolder", folderId: parent.id, parentId: child.id },
      ]),
    ).toThrow(/descendant/);
  });

  it("deletes only empty folders and unreferenced non-final compositions", () => {
    const source = createDemoProject();
    const removableComposition = structuredClone(source.compositions[0]);
    if (!removableComposition) return;
    removableComposition.id = crypto.randomUUID();
    removableComposition.name = "Removable";
    removableComposition.layers = [];
    const folder = { id: crypto.randomUUID(), name: "Empty" };
    const removable = applyOperations(source, [
      { type: "addComposition", composition: removableComposition, activate: false },
      { type: "addProjectFolder", folder },
      { type: "removeProjectFolder", folderId: folder.id },
      { type: "removeComposition", compositionId: removableComposition.id },
    ]);
    expect(removable.folders).toHaveLength(0);
    expect(removable.compositions).toHaveLength(1);
    expect(() =>
      applyOperations(removable, [
        { type: "removeComposition", compositionId: removable.compositions[0]?.id ?? "missing" },
      ]),
    ).toThrow(/keep one composition/);
  });

  it("persists frame-aligned work areas and normalizes them when duration shrinks", () => {
    const source = createDemoProject();
    const composition = activeComposition(source);
    const edited = applyOperations(source, [
      {
        type: "setCompositionWorkArea",
        compositionId: composition.id,
        start: 2.019,
        end: 5.011,
      },
    ]);
    expect(activeComposition(edited).workArea).toEqual({
      start: 121 / 60,
      end: 301 / 60,
    });

    const resized = applyOperations(edited, [
      {
        type: "setCompositionSettings",
        compositionId: composition.id,
        name: composition.name,
        width: composition.width,
        height: composition.height,
        frameRate: composition.frameRate,
        duration: 3,
      },
    ]);
    expect(activeComposition(resized).workArea).toEqual({ start: 121 / 60, end: 3 });
  });

  it("precomposes with stable IDs through a deterministic operation", () => {
    const source = createDemoProject();
    const layerId = activeComposition(source).layers[0].id;
    const plan = planPrecomposition(source, [layerId]);
    expect(plan).toBeDefined();
    if (!plan) return;
    const operation = { type: "precomposeLayers" as const, ...plan };
    const first = applyOperations(source, [operation]);
    const replay = applyOperations(source, [structuredClone(operation)]);
    expect({ ...first, updatedAt: "" }).toEqual({ ...replay, updatedAt: "" });
    expect(activeComposition(first).layers[plan.insertionIndex].id).toBe(plan.wrapper.id);
    expect(first.compositions.some((entry) => entry.id === plan.nestedComposition.id)).toBe(true);
  });

  it("toggles an effect without mutating the source project", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers.find((entry) => entry.effects.length > 0);
    expect(layer).toBeDefined();
    const effect = layer?.effects[0];
    expect(effect).toBeDefined();

    const next = applyOperations(source, [
      { type: "toggleEffect", layerId: layer?.id ?? "", effectId: effect?.id ?? "" },
    ]);

    const toggled = activeComposition(next).layers.find((entry) => entry.id === layer?.id);
    expect(toggled?.effects[0].enabled).toBe(!effect?.enabled);
    expect(effect?.enabled).toBe(true);
  });
});
