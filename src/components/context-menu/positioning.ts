export interface ContextMenuPositionInput {
  anchorX: number;
  anchorY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  placement?: "root" | "submenu";
  margin?: number;
  gap?: number;
  anchorWidth?: number;
}

export interface ContextMenuPosition {
  left: number;
  top: number;
  opensLeft: boolean;
  opensUp: boolean;
}

export function positionContextMenu(input: ContextMenuPositionInput): ContextMenuPosition {
  const margin = finiteNonNegative(input.margin, 6);
  const gap = finiteNonNegative(input.gap, 3);
  const viewportWidth = Math.max(0, finite(input.viewportWidth));
  const viewportHeight = Math.max(0, finite(input.viewportHeight));
  const width = Math.max(0, finite(input.menuWidth));
  const height = Math.max(0, finite(input.menuHeight));
  const anchorX = finite(input.anchorX);
  const anchorY = finite(input.anchorY);
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const maxTop = Math.max(margin, viewportHeight - height - margin);
  const root = input.placement !== "submenu";
  const preferredLeft = root ? anchorX : anchorX + finiteNonNegative(input.anchorWidth, 0) + gap;
  const fallbackLeft = root ? anchorX - width : anchorX - width - gap;
  const opensLeft = preferredLeft + width > viewportWidth - margin && fallbackLeft >= margin;
  const preferredTop = anchorY;
  const fallbackTop = anchorY - height;
  const opensUp = preferredTop + height > viewportHeight - margin && fallbackTop >= margin;
  return {
    left: clamp(opensLeft ? fallbackLeft : preferredLeft, margin, maxLeft),
    top: clamp(opensUp ? fallbackTop : preferredTop, margin, maxTop),
    opensLeft,
    opensUp,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, finite(value));
}
