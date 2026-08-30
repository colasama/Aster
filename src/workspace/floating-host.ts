import { setFloatingBounds, type WorkspaceBounds, type WorkspaceLayout } from "./layout";

export interface WorkspaceFloatingHost {
  readonly width: number;
  readonly height: number;
  readonly displayId?: string;
  readonly leftInset?: number;
  readonly topInset?: number;
}

/**
 * Keeps DOM-hosted floating groups reachable after a window/monitor topology change.
 * Bounds are in the editor host's CSS-pixel coordinate space; no panel surface or GPU
 * renderer is cloned while remapping.
 */
export function remapFloatingWorkspacesToHost(
  layout: WorkspaceLayout,
  host: WorkspaceFloatingHost,
): WorkspaceLayout {
  if (!Number.isFinite(host.width) || !Number.isFinite(host.height)) return layout;
  const width = Math.max(160, host.width);
  const height = Math.max(120, host.height);
  const leftInset = Math.max(0, Math.min(width - 160, host.leftInset ?? 0));
  const topInset = Math.max(0, Math.min(height - 120, host.topInset ?? 0));
  let result = layout;
  for (const floating of layout.floating) {
    const bounds = fitBounds(floating.bounds, width, height, leftInset, topInset);
    result = setFloatingBounds(result, floating.id, bounds, host.displayId ?? floating.displayId);
  }
  return result;
}

function fitBounds(
  bounds: WorkspaceBounds,
  hostWidth: number,
  hostHeight: number,
  leftInset: number,
  topInset: number,
): WorkspaceBounds {
  const width = Math.min(bounds.width, hostWidth - leftInset);
  const height = Math.min(bounds.height, hostHeight - topInset);
  return {
    x: Math.max(leftInset, Math.min(hostWidth - width, bounds.x)),
    y: Math.max(topInset, Math.min(hostHeight - height, bounds.y)),
    width,
    height,
  };
}
