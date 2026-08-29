import { describe, expect, it } from "vitest";
import {
  activatePanel,
  closeGroup,
  closeOtherPanels,
  closePanel,
  createViewer,
  dockGroup,
  dockGroupToRoot,
  dockPanel,
  dockPanelToRoot,
  findWorkspaceNode,
  floatGroup,
  floatPanel,
  groupPanel,
  movePanelToTabSlot,
  normalizeWorkspaceLayout,
  reopenPanel,
  resizeSplit,
  setFloatingBounds,
  setGroupPresentation,
  setViewerLock,
  toggleMaximizedGroup,
  toggleStackPanel,
  toggleStackSolo,
  type WorkspaceLayout,
  type WorkspaceNode,
  workspacePanelIds,
  workspaceTabGroups,
} from "./layout";

const tabGroup = (id: string, panels: readonly string[], activePanelId = panels[0] ?? "missing") =>
  ({ kind: "tabGroup", id, panels, activePanelId }) as const;

function nestedLayout(): WorkspaceLayout {
  return {
    root: {
      kind: "split",
      id: "root-split",
      axis: "horizontal",
      ratio: 0.3,
      first: tabGroup("project-tabs", ["project", "effects"], "project"),
      second: {
        kind: "split",
        id: "detail-split",
        axis: "vertical",
        ratio: 0.6,
        first: tabGroup("viewport-tabs", ["viewport"]),
        second: tabGroup("timeline-tabs", ["timeline"]),
      },
    },
    floating: [
      {
        id: "floating-1",
        node: tabGroup("inspector-tabs", ["inspector"]),
        bounds: { x: 100, y: 80, width: 420, height: 560 },
        displayId: "display-2",
      },
    ],
    closedPanels: ["audio"],
  };
}

describe("workspace layout", () => {
  it("normalizes ratios, active tabs, duplicate panels, floating bounds, and closed panels", () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: "split",
        id: "root-split",
        axis: "horizontal",
        ratio: Number.NaN,
        first: tabGroup("project-tabs", ["project", "project"], "missing"),
        second: tabGroup("duplicate-tabs", ["project", "effects"], "project"),
      },
      floating: [
        {
          id: "floating-1",
          node: tabGroup("timeline-tabs", ["timeline"]),
          bounds: { x: Number.POSITIVE_INFINITY, y: 40, width: 40, height: 90 },
          displayId: "  display-2  ",
        },
      ],
      closedPanels: ["timeline", "audio", "audio", "project"],
    };

    const normalized = normalizeWorkspaceLayout(layout);
    const root = normalized.root as WorkspaceNode;
    expect(root).toMatchObject({ kind: "split", ratio: 0.5 });
    expect(findWorkspaceNode(normalized, "project-tabs")).toEqual(
      tabGroup("project-tabs", ["project"], "project"),
    );
    expect(findWorkspaceNode(normalized, "duplicate-tabs")).toEqual(
      tabGroup("duplicate-tabs", ["effects"], "effects"),
    );
    expect(normalized.floating[0]).toMatchObject({
      bounds: { x: 0, y: 40, width: 160, height: 120 },
      displayId: "display-2",
    });
    expect(normalized.closedPanels).toEqual(["audio"]);
    expect(normalizeWorkspaceLayout(normalized)).toBe(normalized);
  });

  it("resizes only the affected split branch and preserves no-op identity", () => {
    const layout = nestedLayout();
    const root = layout.root;
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split" || root.second.kind !== "split") return;

    const resized = resizeSplit(layout, "detail-split", 0.72);
    expect(resized).not.toBe(layout);
    expect(resized.floating).toBe(layout.floating);
    expect(resized.closedPanels).toBe(layout.closedPanels);
    expect(resized.root).not.toBe(root);
    if (resized.root?.kind !== "split" || resized.root.second.kind !== "split") return;
    expect(resized.root.first).toBe(root.first);
    expect(resized.root.second).not.toBe(root.second);
    expect(resized.root.second.first).toBe(root.second.first);
    expect(resized.root.second.second).toBe(root.second.second);
    expect(resized.root.second.ratio).toBe(0.72);
    expect(resizeSplit(resized, "detail-split", 0.72)).toBe(resized);
    expect(resizeSplit(layout, "unknown", 0.5)).toBe(layout);
  });

  it("groups a panel into an existing tab group without duplicating it", () => {
    const layout = nestedLayout();
    const grouped = groupPanel(layout, "effects", "viewport-tabs");

    expect(findWorkspaceNode(grouped, "project-tabs")).toEqual(
      tabGroup("project-tabs", ["project"], "project"),
    );
    expect(findWorkspaceNode(grouped, "viewport-tabs")).toEqual(
      tabGroup("viewport-tabs", ["viewport", "effects"], "effects"),
    );
    expect(workspacePanelIds(grouped).filter((panel) => panel === "effects")).toHaveLength(1);
    expect(groupPanel(grouped, "effects", "viewport-tabs")).toBe(grouped);
  });

  it("reorders tabs and inserts across groups using pre-detach tab slots", () => {
    const layout = nestedLayout();
    const reordered = movePanelToTabSlot(layout, "effects", "project-tabs", 0);
    expect(findWorkspaceNode(reordered, "project-tabs")).toEqual(
      tabGroup("project-tabs", ["effects", "project"], "effects"),
    );

    const moved = movePanelToTabSlot(layout, "effects", "viewport-tabs", 0);
    expect(findWorkspaceNode(moved, "project-tabs")).toEqual(
      tabGroup("project-tabs", ["project"], "project"),
    );
    expect(findWorkspaceNode(moved, "viewport-tabs")).toEqual(
      tabGroup("viewport-tabs", ["effects", "viewport"], "effects"),
    );
    expect(workspacePanelIds(moved).filter((panel) => panel === "effects")).toHaveLength(1);
    expect(movePanelToTabSlot(moved, "effects", "viewport-tabs", 1)).toBe(moved);
  });

  it("docks panels on deterministic split sides and rejects invalid targets", () => {
    const layout = nestedLayout();
    const docked = dockPanel(layout, "properties", "viewport-tabs", "top");
    const detail = findWorkspaceNode(docked, "detail-split");
    expect(detail?.kind).toBe("split");
    if (detail?.kind !== "split") return;
    expect(detail.first).toMatchObject({
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "tabGroup", id: "tab-group-1", panels: ["properties"] },
      second: { id: "viewport-tabs" },
    });
    expect(dockPanel(layout, "properties", "missing", "left")).toBe(layout);
    expect(dockPanel(layout, "properties", "root-split", "center")).toBe(layout);

    const repeated = dockPanel(structuredClone(layout), "properties", "viewport-tabs", "top");
    expect(repeated).toEqual(docked);
  });

  it("floats, closes, and reopens panels while preserving unaffected containers", () => {
    const layout = nestedLayout();
    const floated = floatPanel(
      layout,
      "effects",
      { x: 250, y: 110, width: 600, height: 440 },
      "display-3",
    );
    expect(floated.floating).toHaveLength(2);
    expect(floated.floating[1]).toMatchObject({
      id: "floating-2",
      bounds: { x: 250, y: 110, width: 600, height: 440 },
      displayId: "display-3",
      node: { kind: "tabGroup", id: "tab-group-1", panels: ["effects"] },
    });
    expect(workspacePanelIds(floated).filter((panel) => panel === "effects")).toHaveLength(1);

    const closed = closePanel(floated, "timeline");
    expect(closed.floating).toBe(floated.floating);
    expect(closed.closedPanels).toEqual(["audio", "timeline"]);
    expect(findWorkspaceNode(closed, "detail-split")).toBeUndefined();

    const reopened = reopenPanel(closed, "timeline", "project-tabs");
    expect(reopened.closedPanels).toEqual(["audio"]);
    expect(findWorkspaceNode(reopened, "project-tabs")).toEqual(
      tabGroup("project-tabs", ["project", "timeline"], "timeline"),
    );
    expect(closePanel(reopened, "missing")).toBe(reopened);
    expect(reopenPanel(reopened, "missing", "project-tabs")).toBe(reopened);
  });

  it("reopens into a new root when every docked panel is closed", () => {
    const layout: WorkspaceLayout = {
      root: tabGroup("only-tabs", ["project"]),
      floating: [],
      closedPanels: [],
    };
    const closed = closePanel(layout, "project");
    expect(closed.root).toBeNull();
    const reopened = reopenPanel(closed, "project");
    expect(reopened).toEqual({
      root: tabGroup("tab-group-1", ["project"]),
      floating: [],
      closedPanels: [],
    });
  });

  it("activates tabs with path-only structural sharing and preserves no-op identity", () => {
    const layout = nestedLayout();
    const activated = activatePanel(layout, "project-tabs", "effects");
    expect(activated).not.toBe(layout);
    expect(activated.floating).toBe(layout.floating);
    expect(findWorkspaceNode(activated, "project-tabs")).toMatchObject({
      activePanelId: "effects",
    });
    if (layout.root?.kind !== "split" || activated.root?.kind !== "split") return;
    expect(activated.root.second).toBe(layout.root.second);
    expect(activatePanel(activated, "project-tabs", "effects")).toBe(activated);
    expect(activatePanel(layout, "project-tabs", "missing")).toBe(layout);
  });

  it("moves complete groups to center and edge targets without rebuilding their panels", () => {
    const layout = nestedLayout();
    const grouped = dockGroup(layout, "project-tabs", "viewport-tabs", "center");
    expect(findWorkspaceNode(grouped, "project-tabs")).toBeUndefined();
    expect(findWorkspaceNode(grouped, "viewport-tabs")).toEqual(
      tabGroup("viewport-tabs", ["viewport", "project", "effects"], "project"),
    );
    expect(grouped.floating).toBe(layout.floating);

    const edged = dockGroup(layout, "inspector-tabs", "timeline-tabs", "right");
    expect(edged.floating).toHaveLength(0);
    const inserted = findWorkspaceNode(edged, "split-1");
    expect(inserted).toMatchObject({
      kind: "split",
      axis: "horizontal",
      first: { id: "timeline-tabs" },
      second: { id: "inspector-tabs", panels: ["inspector"] },
    });
    expect(dockGroup(layout, "viewport-tabs", "viewport-tabs", "left")).toBe(layout);
  });

  it("floats whole groups and commits floating bounds without changing their node", () => {
    const layout = nestedLayout();
    const floated = floatGroup(layout, "viewport-tabs", {
      x: 80,
      y: 90,
      width: 800,
      height: 600,
    });
    const entry = floated.floating[floated.floating.length - 1];
    expect(entry?.node).toMatchObject({ id: "viewport-tabs", panels: ["viewport"] });
    expect(findWorkspaceNode(floated, "detail-split")).toBeUndefined();
    if (!entry) return;
    const moved = setFloatingBounds(floated, entry.id, {
      x: 160,
      y: 140,
      width: 800,
      height: 600,
    });
    expect(moved.root).toBe(floated.root);
    expect(moved.floating[1].node).toBe(entry.node);
    expect(moved.floating[1].bounds.x).toBe(160);
    expect(setFloatingBounds(moved, entry.id, moved.floating[1].bounds)).toBe(moved);
  });

  it("closes group selections and docks floating panel or group content back to the root", () => {
    const layout = nestedLayout();
    const closedOthers = closeOtherPanels(layout, "project-tabs", "project");
    expect(findWorkspaceNode(closedOthers, "project-tabs")).toEqual(
      tabGroup("project-tabs", ["project"]),
    );
    expect(closedOthers.closedPanels).toEqual(["audio", "effects"]);
    const closed = closeGroup(layout, "project-tabs");
    expect(findWorkspaceNode(closed, "project-tabs")).toBeUndefined();
    expect(closed.closedPanels).toEqual(["audio", "effects", "project"]);

    const panelDocked = dockPanelToRoot(layout, "inspector");
    expect(panelDocked.floating).toHaveLength(0);
    expect(findWorkspaceNode(panelDocked, "project-tabs")).toMatchObject({
      panels: ["project", "effects", "inspector"],
    });
    const groupDocked = dockGroupToRoot(layout, "inspector-tabs");
    expect(groupDocked.floating).toHaveLength(0);
    expect(findWorkspaceNode(groupDocked, "project-tabs")).toMatchObject({
      panels: ["project", "effects", "inspector"],
    });
    expect(
      workspaceTabGroups(layout).map(({ group, floatingId }) => [group.id, floatingId]),
    ).toEqual([
      ["project-tabs", undefined],
      ["viewport-tabs", undefined],
      ["timeline-tabs", undefined],
      ["inspector-tabs", "floating-1"],
    ]);
  });

  it("persists stacked presentation, solo expansion, and simultaneous stack toggles", () => {
    const layout = nestedLayout();
    const stacked = setGroupPresentation(layout, "project-tabs", "stacked");
    expect(findWorkspaceNode(stacked, "project-tabs")).toMatchObject({
      presentation: "stacked",
      stackSolo: true,
      expandedPanelIds: ["project"],
    });
    expect(
      findWorkspaceNode(
        toggleStackPanel(stacked, "project-tabs", "effects", false, true),
        "project-tabs",
      ),
    ).toMatchObject({
      activePanelId: "effects",
      stackSolo: false,
      expandedPanelIds: ["project", "effects"],
    });

    const soloed = toggleStackPanel(stacked, "project-tabs", "effects");
    expect(findWorkspaceNode(soloed, "project-tabs")).toMatchObject({
      activePanelId: "effects",
      expandedPanelIds: ["effects"],
    });
    const allExpanded = toggleStackPanel(soloed, "project-tabs", "project", true);
    expect(findWorkspaceNode(allExpanded, "project-tabs")).toMatchObject({
      expandedPanelIds: ["project", "effects"],
    });
    const multi = toggleStackSolo(allExpanded, "project-tabs");
    expect(findWorkspaceNode(multi, "project-tabs")).toMatchObject({ stackSolo: false });
    const collapsedOne = toggleStackPanel(multi, "project-tabs", "effects");
    expect(findWorkspaceNode(collapsedOne, "project-tabs")).toMatchObject({
      expandedPanelIds: ["project"],
    });
    expect(
      findWorkspaceNode(setGroupPresentation(collapsedOne, "project-tabs", "tabs"), "project-tabs"),
    ).toEqual(tabGroup("project-tabs", ["project", "effects"], "effects"));
  });

  it("stores maximize in the layout and clears a stale maximized group during normalization", () => {
    const layout = nestedLayout();
    const maximized = toggleMaximizedGroup(layout, "viewport-tabs");
    expect(maximized.maximizedGroupId).toBe("viewport-tabs");
    expect(toggleMaximizedGroup(maximized, "viewport-tabs").maximizedGroupId).toBeUndefined();
    const closed = closePanel(maximized, "viewport");
    expect(normalizeWorkspaceLayout(closed).maximizedGroupId).toBeUndefined();
  });

  it("creates stable viewer identities and splits with opposite lock state", () => {
    const layout = nestedLayout();
    const locked = setViewerLock(
      layout,
      "viewport",
      "viewport",
      "composition",
      true,
      "composition-1",
    );
    expect(locked.viewers).toEqual([
      {
        id: "viewport",
        sourcePanelId: "viewport",
        viewerType: "composition",
        locked: true,
        contextId: "composition-1",
      },
    ]);
    const split = createViewer(
      locked,
      "viewport",
      "viewport",
      "composition",
      "composition-1",
      true,
    );
    expect(split.viewers).toEqual([
      {
        id: "viewport",
        sourcePanelId: "viewport",
        viewerType: "composition",
        locked: true,
        contextId: "composition-1",
      },
      {
        id: "viewport::viewer-2",
        sourcePanelId: "viewport",
        viewerType: "composition",
        locked: false,
      },
    ]);
    expect(findWorkspaceNode(split, "split-1")).toMatchObject({
      axis: "horizontal",
      first: { id: "viewport-tabs", panels: ["viewport"] },
      second: { panels: ["viewport::viewer-2"] },
    });
    expect(workspacePanelIds(split)).toContain("viewport::viewer-2");
  });

  it("bounds live viewer instances per source so visible splits stay predictable", () => {
    let layout = nestedLayout();
    for (let index = 0; index < 3; index += 1)
      layout = createViewer(layout, "viewport", "viewport", "composition", "composition-1", true);
    expect(
      workspacePanelIds(layout).filter(
        (panelId) => panelId === "viewport" || panelId.startsWith("viewport::viewer-"),
      ),
    ).toHaveLength(4);
    expect(createViewer(layout, "viewport", "viewport", "composition", "composition-1", true)).toBe(
      layout,
    );
    const closed = closePanel(layout, "viewport::viewer-4");
    expect(closed.closedPanels).not.toContain("viewport::viewer-4");
    expect(closed.viewers?.some((viewer) => viewer.id === "viewport::viewer-4")).toBe(false);
    expect(
      createViewer(closed, "viewport", "viewport", "composition", "composition-1", true),
    ).not.toBe(closed);
  });
});
