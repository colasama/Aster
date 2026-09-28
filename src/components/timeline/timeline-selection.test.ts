import { describe, expect, it } from "vitest";
import { timelineClickSelection } from "./timeline-selection";

const layers = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("timeline click selection", () => {
  it("selects only the clicked layer on a plain click", () => {
    expect(timelineClickSelection(layers, ["a", "c"], "b", false, false)).toEqual(["b"]);
  });

  it("toggles one layer with Ctrl/Cmd", () => {
    expect(timelineClickSelection(layers, ["a"], "c", false, true)).toEqual(["a", "c"]);
    expect(timelineClickSelection(layers, ["a", "c"], "c", false, true)).toEqual(["a"]);
  });

  it("selects a range from the primary layer with Shift in either direction", () => {
    expect(timelineClickSelection(layers, ["b"], "d", true, false)).toEqual(["b", "c", "d"]);
    expect(timelineClickSelection(layers, ["c"], "a", true, false)).toEqual(["c", "a", "b"]);
  });

  it("adds a range to the selection with Ctrl/Cmd+Shift and toggles without an anchor", () => {
    expect(timelineClickSelection(layers, ["a", "d"], "b", true, true)).toEqual(["a", "d", "b"]);
    expect(timelineClickSelection(layers, [], "b", true, false)).toEqual(["b"]);
  });
});
