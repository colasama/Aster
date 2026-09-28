import { DEFAULT_WORKSPACE_LAYOUT } from "./default-layout";
import { replaceNodeInLayout, workspacePanelIds, workspaceTabGroups } from "./layout-tree";
import type { WorkspaceLayout } from "./layout-types";

/** Panels that share a tab group in the default workspace are each other's natural neighbours. */
function defaultCompanions(panelId: string): readonly string[] {
  return (
    workspaceTabGroups(DEFAULT_WORKSPACE_LAYOUT)
      .find(({ group }) => group.panels.includes(panelId))
      ?.group.panels.filter((candidate) => candidate !== panelId) ?? []
  );
}

/**
 * Chooses the visible tab group that holds one of the panel's default companions, so a reopened
 * panel returns to its usual region instead of the first group in the tree.
 */
export function preferredPanelGroupId(
  layout: WorkspaceLayout,
  panelId: string,
): string | undefined {
  const companions = defaultCompanions(panelId);
  return workspaceTabGroups(layout).find(({ group }) =>
    group.panels.some((candidate) => companions.includes(candidate)),
  )?.group.id;
}

/**
 * Adds a panel that a layout has never seen as an inactive tab beside an anchor panel. Layouts
 * without the anchor keep the panel closed so it stays reachable from the Window menu.
 */
export function insertPanelBeside(
  layout: WorkspaceLayout,
  panelId: string,
  anchorPanelId: string,
): WorkspaceLayout {
  if (workspacePanelIds(layout).includes(panelId) || layout.closedPanels.includes(panelId))
    return layout;
  const anchor = workspaceTabGroups(layout).find(({ group }) =>
    group.panels.includes(anchorPanelId),
  );
  const inserted = anchor
    ? replaceNodeInLayout(layout, anchor.group.id, (node) => {
        if (node.kind !== "tabGroup") return node;
        const panels = [...node.panels];
        panels.splice(panels.indexOf(anchorPanelId) + 1, 0, panelId);
        return { ...node, panels };
      })
    : undefined;
  return inserted ?? { ...layout, closedPanels: [...layout.closedPanels, panelId] };
}
