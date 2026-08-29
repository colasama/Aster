import { Move } from "lucide-react";
import { type PointerEvent, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../i18n/react";
import { type FloatingResizeEdges, resizeFloatingBounds } from "../../workspace/interaction";
import type { FloatingWorkspace, WorkspaceBounds } from "../../workspace/layout";
import { browserAnimationFrameHost, RafCoalescer } from "../../workspace/raf-coalescer";
import { DockNode, type DockNodeProps } from "./DockNode";

export function FloatingWorkspaceFrame({
  active,
  entry,
  onFocus,
  onMove,
  ...props
}: Omit<DockNodeProps, "node"> & {
  readonly entry: FloatingWorkspace;
  readonly active: boolean;
  readonly onFocus: () => void;
  readonly onMove: (floatingId: string, bounds: WorkspaceBounds) => void;
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    bounds: WorkspaceBounds;
    edges?: FloatingResizeEdges;
  } | null>(null);
  const pending = useRef(entry.bounds);
  const coalescer = useMemo(
    () =>
      new RafCoalescer<WorkspaceBounds>(browserAnimationFrameHost(), (bounds) => {
        pending.current = bounds;
        const frame = frameRef.current;
        if (!frame || !drag.current) return;
        if (!drag.current.edges) {
          frame.style.transform = `translate(${bounds.x - entry.bounds.x}px, ${bounds.y - entry.bounds.y}px)`;
          return;
        }
        const preview = previewRef.current;
        if (!preview) return;
        preview.style.left = `${bounds.x}px`;
        preview.style.top = `${bounds.y}px`;
        preview.style.width = `${bounds.width}px`;
        preview.style.height = `${bounds.height}px`;
      }),
    [entry.bounds.x, entry.bounds.y],
  );
  useEffect(() => () => coalescer.cancel(), [coalescer]);
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    const deltaX = event.clientX - current.x;
    const deltaY = event.clientY - current.y;
    coalescer.schedule(
      current.edges
        ? resizeFloatingBounds(current.bounds, deltaX, deltaY, current.edges)
        : {
            ...current.bounds,
            x: Math.max(0, current.bounds.x + deltaX),
            y: Math.max(31, current.bounds.y + deltaY),
          },
    );
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, edges?: FloatingResizeEdges) => {
    onFocus();
    drag.current = { x: event.clientX, y: event.clientY, bounds: entry.bounds, edges };
    pending.current = entry.bounds;
    if (edges) previewRef.current?.classList.add("active");
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (!drag.current) return;
    if (commit) {
      move(event);
      coalescer.flush();
    } else coalescer.cancel();
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    frameRef.current?.style.removeProperty("transform");
    previewRef.current?.classList.remove("active");
    if (commit) onMove(entry.id, pending.current);
  };
  return (
    <div
      className={`workspace-floating ${active ? "active" : ""}`}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
      ref={frameRef}
      style={{
        left: entry.bounds.x,
        top: entry.bounds.y,
        width: entry.bounds.width,
        height: entry.bounds.height,
      }}
    >
      <button
        className="workspace-floating-move"
        aria-label={t("workspace.moveFloating")}
        onPointerCancel={(event) => finish(event, false)}
        onPointerDown={(event) => begin(event)}
        onPointerMove={move}
        onPointerUp={(event) => finish(event, true)}
        title={t("workspace.moveFloating")}
        type="button"
      >
        <Move size={11} />
      </button>
      <DockNode {...props} node={entry.node} />
      {FLOATING_RESIZE_HANDLES.map(({ className, edges }) => (
        <button
          aria-label={t("workspace.resizeFloating")}
          className={`workspace-floating-resize ${className}`}
          key={className}
          onPointerCancel={(event) => finish(event, false)}
          onPointerDown={(event) => begin(event, edges)}
          onPointerMove={move}
          onPointerUp={(event) => finish(event, true)}
          tabIndex={-1}
          type="button"
        />
      ))}
      <div aria-hidden="true" className="workspace-floating-resize-preview" ref={previewRef} />
    </div>
  );
}

const FLOATING_RESIZE_HANDLES: readonly {
  readonly className: string;
  readonly edges: FloatingResizeEdges;
}[] = [
  { className: "top", edges: { top: true } },
  { className: "right", edges: { right: true } },
  { className: "bottom", edges: { bottom: true } },
  { className: "left", edges: { left: true } },
  { className: "top-left", edges: { top: true, left: true } },
  { className: "top-right", edges: { top: true, right: true } },
  { className: "bottom-right", edges: { bottom: true, right: true } },
  { className: "bottom-left", edges: { bottom: true, left: true } },
];
