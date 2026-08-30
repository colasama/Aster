import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { positionContextMenu } from "./positioning";

const UI_SCALES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

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

  it.each(UI_SCALES)("keeps root and submenu bounds reachable at %s UI scale", (scale) => {
    const viewportWidth = 1_440 / scale;
    const viewportHeight = 900 / scale;
    const menuWidth = Math.min(260, viewportWidth - 12);
    const menuHeight = Math.min(420, viewportHeight - 12);
    for (const placement of ["root", "submenu"] as const) {
      const position = positionContextMenu({
        anchorX: viewportWidth - 3,
        anchorY: viewportHeight - 3,
        anchorWidth: 120,
        menuWidth,
        menuHeight,
        placement,
        viewportWidth,
        viewportHeight,
      });
      expect(position.left).toBeGreaterThanOrEqual(6);
      expect(position.top).toBeGreaterThanOrEqual(6);
      expect(position.left + menuWidth).toBeLessThanOrEqual(viewportWidth - 6);
      expect(position.top + menuHeight).toBeLessThanOrEqual(viewportHeight - 6);
    }
  });

  it("gives long menus a scroll boundary while keeping portalled submenus above the root", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/context-menu.css"), "utf8");
    expect(styles).toMatch(
      /\.context-menu-surface\s*\{[^}]*z-index:\s*501;[^}]*max-height:\s*calc\(100vh - 12px\);[^}]*overflow-y:\s*auto;/s,
    );
  });
});
