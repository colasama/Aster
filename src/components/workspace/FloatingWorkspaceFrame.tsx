import { Move } from "lucide-react";
import { type PointerEvent, useEffect, useMemo, useRef } from "react";
import type { FloatingWorkspace, WorkspaceBounds } from "../../workspace/layout";
import { browserAnimationFrameHost, RafCoalescer } from "../../workspace/raf-coalescer";
import { DockNode, type DockNodeProps } from "./DockNode";

export function FloatingWorkspaceFrame({
  entry,
  onMove,
  ...props
}: Omit<DockNodeProps, "node"> & {
  readonly entry: FloatingWorkspace;
  readonly onMove: (floatingId: string, bounds: WorkspaceBounds) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; bounds: WorkspaceBounds } | null>(null);
  const pending = useRef(entry.bounds);
  const coalescer = useMemo(
    () =>
      new RafCoalescer<WorkspaceBounds>(browserAnimationFrameHost(), (bounds) => {
        pending.current = bounds;
        const frame = frameRef.current;
        if (!frame) return;
        frame.style.transform = `translate(${bounds.x - entry.bounds.x}px, ${bounds.y - entry.bounds.y}px)`;
      }),
    [entry.bounds.x, entry.bounds.y],
  );
  useEffect(() => () => coalescer.cancel(), [coalescer]);
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    coalescer.schedule({
      ...current.bounds,
      x: Math.max(0, current.bounds.x + event.clientX - current.x),
      y: Math.max(31, current.bounds.y + event.clientY - current.y),
    });
  };
  return (
    <div
      className="workspace-floating"
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
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, bounds: entry.bounds };
          pending.current = entry.bounds;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (!drag.current) return;
          move(event);
          coalescer.flush();
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          frameRef.current?.style.removeProperty("transform");
          onMove(entry.id, pending.current);
        }}
        title="Move floating group"
        type="button"
      >
        <Move size={11} />
      </button>
      <DockNode {...props} node={entry.node} />
    </div>
  );
}
