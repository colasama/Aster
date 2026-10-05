import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import type { Composition } from "../../core/types";
import {
  evaluatePrecompositionGeometry,
  evaluatePrecompositionSources,
} from "./precomposition-source-evaluation";

function fixture(times = [1.25, 1.25, 2.5]) {
  const project = createBlankProject(),
    root = project.compositions[0];
  root.width = 64;
  root.height = 48;
  const parent = { ...structuredClone(root), id: "parent" },
    leaf = { ...structuredClone(root), id: "leaf" };
  const wrapper = (composition: Composition, source: Composition, time?: number) => {
    const layer = createLayerForComposition("precomposition", composition);
    layer.sourceCompositionId = source.id;
    layer.threeDimensional = true;
    if (time !== undefined) layer.timeRemap = { mode: "static", value: time };
    return layer;
  };
  leaf.layers = [createLayerForComposition("image", leaf)];
  parent.layers = [wrapper(parent, leaf)];
  root.layers = times.map((time) => wrapper(root, parent, time));
  project.compositions.push(parent, leaf);
  return {
    project,
    root,
    sceneLayers: flattenSceneLayers(root, project, 0),
    revision: 7,
    maxTextureDimension: 4096,
  };
}

describe("CPU precomposition source evaluation", () => {
  it("evaluates distinct times, shared aliases, media and child-first geometry without a device", () => {
    const input = fixture();
    const frame = evaluatePrecompositionSources(input);
    expect(frame.budget).toEqual({
      surfaces: 4,
      textures: 8,
      pixels: 64 * 48 * 4,
      bytes: 64 * 48 * 4 * 12,
    });
    expect(frame.bindings.get(input.sceneLayers[0].instanceId)).toBe(
      frame.bindings.get(input.sceneLayers[1].instanceId),
    );
    expect(frame.bindings.get(input.sceneLayers[0].instanceId)).not.toBe(
      frame.bindings.get(input.sceneLayers[2].instanceId),
    );
    expect(frame.operations.map((o) => o.kind)).toEqual([
      "target",
      "target",
      "media",
      "scene",
      "scene",
      "target",
      "target",
      "media",
      "scene",
      "scene",
    ]);
    const scenes = frame.operations.filter((o) => o.kind === "scene").map((o) => o.source);
    expect(scenes.map((s) => [s.composition.id, s.time])).toEqual([
      ["leaf", 1.25],
      ["parent", 1.25],
      ["leaf", 2.5],
      ["parent", 2.5],
    ]);
    for (const source of scenes) {
      const result = evaluatePrecompositionGeometry(source, () => undefined);
      expect(result.geometry.batches[0].vertexCount).toBeGreaterThan(0);
      expect(result.diagnostics).toEqual([]);
    }
    expect(structuredClone(frame)).toEqual(frame);
    evaluatePrecompositionSources(fixture([4]));
    expect(evaluatePrecompositionSources(input)).toEqual(frame);
  });

  it("makes bounded skip and SSAA failure decisions before allocation", () => {
    const input = fixture(Array.from({ length: 12 }, (_, i) => i / 30));
    const frame = evaluatePrecompositionSources(input);
    expect(frame.budget.surfaces).toBe(10);
    expect(frame.activeKeys.size).toBe(10);
    expect(frame.diagnostics.some((d) => d.includes("surface count"))).toBe(true);
    expect(() =>
      evaluatePrecompositionSources({ ...input, maxTextureDimension: 1, renderScale: 2 }),
    ).toThrow(/SSAA precomposition target unavailable/);
  });

  it("retains cycle rejection and does not schedule media from rejected targets", () => {
    const input = fixture([1]);
    const surface = input.sceneLayers[0].precompositionSurface;
    if (!surface) throw Error("Missing fixture surface");
    surface.compositionPath.push(surface.composition.id);
    const frame = evaluatePrecompositionSources(input);
    expect(frame.operations).toEqual([]);
    expect(frame.bindings.size).toBe(0);
    expect(frame.diagnostics[0]).toContain("cycle detected");
  });
});
