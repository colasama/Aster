import { describe, expect, it } from "vitest";
import { applyOperations } from "./operations";
import { activeComposition, createDemoProject } from "./project";
import type { Lut3dResource } from "./types";

describe("structured project operations", () => {
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

  it("rejects operations that target a missing layer", () => {
    const source = createDemoProject();
    expect(() =>
      applyOperations(source, [{ type: "renameLayer", layerId: "missing", name: "Nope" }]),
    ).toThrow("Layer does not exist");
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

  it("retimes, eases, and removes keyframes through operations", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const opacity = layer.transform.opacity;
    expect(opacity.mode).toBe("animated");
    if (opacity.mode !== "animated") return;
    const keyframe = opacity.keyframes[0];
    const moved = applyOperations(source, [
      {
        type: "moveKeyframe",
        layerId: layer.id,
        path: "opacity",
        keyframeId: keyframe.id,
        time: 0.25,
      },
      { type: "easeLayer", layerId: layer.id },
    ]);
    const movedOpacity = activeComposition(moved).layers[0].transform.opacity;
    expect(movedOpacity.mode).toBe("animated");
    if (movedOpacity.mode !== "animated") return;
    expect(movedOpacity.keyframes.find((entry) => entry.id === keyframe.id)?.time).toBe(0.25);
    expect(movedOpacity.keyframes.every((entry) => entry.interpolation === "bezier")).toBe(true);

    const removed = applyOperations(moved, [
      { type: "removeKeyframe", layerId: layer.id, path: "opacity", keyframeId: keyframe.id },
    ]);
    const removedOpacity = activeComposition(removed).layers[0].transform.opacity;
    expect(removedOpacity.mode === "animated" && removedOpacity.keyframes).toHaveLength(3);
  });

  it("validates parenting cycles", () => {
    const source = createDemoProject();
    const [first, second] = activeComposition(source).layers;
    const parented = applyOperations(source, [
      { type: "setParent", layerId: second.id, parentId: first.id },
    ]);
    expect(activeComposition(parented).layers[1].parentId).toBe(first.id);
    expect(() =>
      applyOperations(parented, [{ type: "setParent", layerId: first.id, parentId: second.id }]),
    ).toThrow("cycle");
  });

  it("attaches LUT resources through an undoable typed operation", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const effect = layer.effects.find((entry) => entry.type === "lut") ?? {
      id: crypto.randomUUID(),
      type: "lut",
      name: "3D LUT",
      enabled: true,
      parameters: { intensity: 100, interpolation: 0 },
    };
    if (!layer.effects.includes(effect)) layer.effects.push(effect);
    const resource: Lut3dResource = {
      kind: "lut3d",
      name: "identity.cube",
      size: 2,
      data: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      checksum: "deadbeef",
    };

    const next = applyOperations(source, [
      { type: "setEffectLut", layerId: layer.id, effectId: effect.id, resource },
    ]);

    expect(
      activeComposition(next).layers[0].effects.find((entry) => entry.id === effect.id)?.resource,
    ).toEqual(resource);
    expect(effect.resource).toBeUndefined();
  });
});
