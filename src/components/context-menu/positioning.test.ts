import { describe, expect, it } from "vitest";
import { positionContextMenu } from "./positioning";

describe("context menu positioning", () => {
  it("keeps a root menu inside the viewport and flips near the lower-right edge", () => {
    expect(
      positionContextMenu({
        anchorX: 790,
        anchorY: 590,
        menuWidth: 220,
        menuHeight: 260,
        viewportWidth: 800,
        viewportHeight: 600,
      }),
    ).toEqual({ left: 570, top: 330, opensLeft: true, opensUp: true });
  });

  it("opens submenus to the right unless the right edge would overflow", () => {
    expect(
      positionContextMenu({
        anchorX: 640,
        anchorY: 100,
        anchorWidth: 150,
        menuWidth: 180,
        menuHeight: 200,
        viewportWidth: 800,
        viewportHeight: 600,
        placement: "submenu",
      }),
    ).toMatchObject({ left: 457, top: 100, opensLeft: true, opensUp: false });
  });

  it("clamps oversized and non-finite measurements deterministically", () => {
    const position = positionContextMenu({
      anchorX: Number.NaN,
      anchorY: Number.POSITIVE_INFINITY,
      menuWidth: 900,
      menuHeight: 700,
      viewportWidth: 800,
      viewportHeight: 600,
    });
    expect(position.left).toBe(6);
    expect(position.top).toBe(6);
  });
});
