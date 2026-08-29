import { dockGroup, dockPanel, type WorkspaceDockPosition, type WorkspaceLayout } from "./layout";

export type WorkspaceDrag =
  | { readonly kind: "panel"; readonly panelId: string }
  | { readonly kind: "group"; readonly groupId: string };

export function applyWorkspaceDrop(
  layout: WorkspaceLayout,
  drag: WorkspaceDrag,
  targetGroupId: string,
  position: WorkspaceDockPosition,
): WorkspaceLayout {
  return drag.kind === "panel"
    ? dockPanel(layout, drag.panelId, targetGroupId, position)
    : dockGroup(layout, drag.groupId, targetGroupId, position);
}

export function nextTabIndex(
  currentIndex: number,
  tabCount: number,
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
): number {
  if (tabCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  const direction = key === "ArrowLeft" ? -1 : 1;
  return (Math.max(0, currentIndex) + direction + tabCount) % tabCount;
}
