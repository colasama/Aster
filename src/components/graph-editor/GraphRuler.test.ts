import { describe, expect, it } from "vitest";
import { graphRulerTicks } from "./GraphRuler";

describe("graph ruler ticks", () => {
  it("chooses readable 1/2/5 steps for the visible range", () => {
    expect(graphRulerTicks({ start: 0, end: 10 }, 900)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(graphRulerTicks({ start: 0.3, end: 1.3 }, 450)).toEqual([0.4, 0.6, 0.8, 1, 1.2]);
  });

  it("returns nothing for empty ranges", () => {
    expect(graphRulerTicks({ start: 1, end: 1 }, 900)).toEqual([]);
    expect(graphRulerTicks({ start: 0, end: 5 }, 0)).toEqual([]);
  });
});
