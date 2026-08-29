import { describe, expect, it } from "vitest";
import {
  applyWorkspaceDrop,
  clampSplitRatioToPixels,
  nextTabIndex,
  resizeFloatingBounds,
  splitRatioBounds,
} from "./interaction";
import type { WorkspaceLayout } from "./layout";

const layout: WorkspaceLayout = {
  root: {
    kind: "split",
    id: "root",
    axis: "horizontal",
    ratio: 0.5,
    first: { kind: "tabGroup", id: "left", panels: ["a", "b"], activePanelId: "a" },
    second: { kind: "tabGroup", id: "right", panels: ["c"], activePanelId: "c" },
  },
  floating: [],
  closedPanels: [],
};

describe("workspace interaction", () => {
  it("maps panel and group drops to one immutable layout operation", () => {
    const panelDrop = applyWorkspaceDrop(
      layout,
      { kind: "panel", panelId: "b" },
      "right",
      "center",
    );
    expect(panelDrop.root).toMatchObject({
      first: { panels: ["a"] },
      second: { panels: ["c", "b"], activePanelId: "b" },
    });
    const groupDrop = applyWorkspaceDrop(
      layout,
      { kind: "group", groupId: "left" },
      "right",
      "center",
    );
    expect(groupDrop.root).toMatchObject({ panels: ["c", "a", "b"], activePanelId: "a" });
  });

  it("wraps overflow tab keyboard navigation deterministically", () => {
    expect(nextTabIndex(0, 4, "ArrowLeft")).toBe(3);
    expect(nextTabIndex(3, 4, "ArrowRight")).toBe(0);
    expect(nextTabIndex(2, 4, "Home")).toBe(0);
    expect(nextTabIndex(1, 4, "End")).toBe(3);
    expect(nextTabIndex(0, 0, "ArrowRight")).toBe(-1);
  });

  it("derives pixel-safe split limits for pointer and keyboard resizing", () => {
    expect(splitRatioBounds(1000, 160, 160)).toEqual({ minimum: 0.16, maximum: 0.84 });
    expect(clampSplitRatioToPixels(0.05, 1000, 160, 160)).toBe(0.16);
    expect(clampSplitRatioToPixels(0.95, 1000, 160, 160)).toBe(0.84);
    expect(splitRatioBounds(240, 160, 160)).toEqual({ minimum: 0.5, maximum: 0.5 });
  });

  it("resizes floating frames from edges without crossing minimum dimensions", () => {
    expect(
      resizeFloatingBounds({ x: 100, y: 80, width: 400, height: 300 }, 80, 50, {
        left: true,
        top: true,
      }),
    ).toEqual({ x: 180, y: 130, width: 320, height: 250 });
    expect(
      resizeFloatingBounds({ x: 100, y: 80, width: 300, height: 200 }, 200, 100, {
        left: true,
        top: true,
      }),
    ).toEqual({ x: 160, y: 120, width: 240, height: 160 });
  });
});
