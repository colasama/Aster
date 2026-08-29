import { dockGroup, dockPanel, type WorkspaceDockPosition, type WorkspaceLayout } from "./layout";

export const MIN_HORIZONTAL_PANE_PIXELS = 160;
export const MIN_VERTICAL_PANE_PIXELS = 120;

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

export interface SplitRatioBounds {
  readonly minimum: number;
  readonly maximum: number;
}

/** Keeps both panes usable in pixels while retaining the persisted ratio model. */
export function splitRatioBounds(
  availablePixels: number,
  minimumFirstPixels: number,
  minimumSecondPixels: number,
): SplitRatioBounds {
  const available = Math.max(0, availablePixels);
  const first = Math.max(0, minimumFirstPixels);
  const second = Math.max(0, minimumSecondPixels);
  if (available <= 0 || first + second > available) return { minimum: 0.5, maximum: 0.5 };
  return {
    minimum: first / available,
    maximum: 1 - second / available,
  };
}

export function clampSplitRatioToPixels(
  ratio: number,
  availablePixels: number,
  minimumFirstPixels: number,
  minimumSecondPixels: number,
): number {
  const bounds = splitRatioBounds(availablePixels, minimumFirstPixels, minimumSecondPixels);
  const value = Number.isFinite(ratio) ? ratio : 0.5;
  return Math.max(bounds.minimum, Math.min(bounds.maximum, value));
}

export interface FloatingResizeEdges {
  readonly top?: boolean;
  readonly right?: boolean;
  readonly bottom?: boolean;
  readonly left?: boolean;
}

export interface FloatingResizeInput {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pure floating-frame resize math shared by all eight handles. */
export function resizeFloatingBounds(
  bounds: FloatingResizeInput,
  deltaX: number,
  deltaY: number,
  edges: FloatingResizeEdges,
  minimumWidth = 240,
  minimumHeight = 160,
): FloatingResizeInput {
  let x = bounds.x;
  let y = bounds.y;
  let width = bounds.width;
  let height = bounds.height;
  if (edges.left) {
    width = Math.max(minimumWidth, bounds.width - deltaX);
    x = bounds.x + bounds.width - width;
  } else if (edges.right) width = Math.max(minimumWidth, bounds.width + deltaX);
  if (edges.top) {
    height = Math.max(minimumHeight, bounds.height - deltaY);
    y = bounds.y + bounds.height - height;
  } else if (edges.bottom) height = Math.max(minimumHeight, bounds.height + deltaY);
  return { x, y, width, height };
}
