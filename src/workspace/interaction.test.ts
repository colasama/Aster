import { describe, expect, it } from "vitest";
import { applyWorkspaceDrop, nextTabIndex } from "./interaction";
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
});
