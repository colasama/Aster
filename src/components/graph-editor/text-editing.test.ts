import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layer-factory";
import { getProperty } from "../../core/operations";
import { activeComposition, createDemoProject } from "../../core/project";
import { createInitialState, editorReducer } from "../../state/editor-store";
import {
  expandSpatialGraphEntries,
  graphEditableKeyframe,
  graphInterpolationOperations,
} from "./editing";
import { collectAnimatedGraphTracks } from "./model";

describe("text animator graph editing", () => {
  it("updates every keyed Position component atomically from the collapsed speed marker", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("text", composition);
    const position = layer.textAnimator?.groups[0]?.properties.position;
    if (!position) throw new Error("Expected text animator Position");
    position[0] = {
      mode: "animated",
      keyframes: [
        { id: "text-x-start", time: 0, value: 0, interpolation: "linear" },
        { id: "text-x-end", time: 1, value: 100, interpolation: "linear" },
      ],
    };
    position[1] = {
      mode: "animated",
      keyframes: [
        { id: "text-y-start", time: 0, value: 0, interpolation: "linear" },
        { id: "text-y-end", time: 1, value: 50, interpolation: "linear" },
      ],
    };
    composition.layers.push(layer);
    const tracks = collectAnimatedGraphTracks(layer);
    const primary = tracks.find((track) => track.id.includes(":property:position:0"));
    if (!primary) throw new Error("Expected Position speed track");
    const owners = tracks.map((track) => ({ layerId: layer.id, track }));
    const entries = expandSpatialGraphEntries(
      [graphEditableKeyframe(layer.id, primary, primary.property.keyframes[0])],
      owners,
      "auto",
    );
    expect(entries.flatMap((entry) => (entry.source === "transform" ? [entry.path] : []))).toEqual([
      expect.stringContaining(":property:position:0"),
      expect.stringContaining(":property:position:1"),
    ]);

    const initial = {
      ...createInitialState(),
      project,
      selection: [layer.id],
      history: { past: [], future: [] },
    };
    const committed = editorReducer(initial, {
      type: "operation",
      operations: graphInterpolationOperations(entries, owners, "bezier", [0.2, 0, 0.8, 1]),
    });
    expect(committed.history.past).toHaveLength(1);
    const edited = activeComposition(committed.project).layers.find(
      (candidate) => candidate.id === layer.id,
    );
    expect(
      entries.map((entry) => {
        if (!edited || entry.source !== "transform") return undefined;
        const property = getProperty(edited, entry.path);
        return property.mode === "animated" ? property.keyframes[0]?.interpolation : undefined;
      }),
    ).toEqual(["bezier", "bezier"]);
  });
});
