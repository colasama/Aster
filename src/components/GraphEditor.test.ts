import { describe, expect, it } from "vitest";
import { graphMarkerRadii } from "./GraphEditor";

describe("graph editor marker geometry", () => {
  it("counteracts non-uniform SVG scaling so markers remain circular", () => {
    const radii = graphMarkerRadii(500, 520, 5);

    expect(radii.x * (500 / 1000)).toBeCloseTo(5);
    expect(radii.y * (520 / 260)).toBeCloseTo(5);
  });

  it("preserves the requested screen radius at the native viewBox size", () => {
    expect(graphMarkerRadii(1000, 260, 4)).toEqual({ x: 4, y: 4 });
  });
});
