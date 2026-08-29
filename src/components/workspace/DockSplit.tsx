import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../i18n/react";
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, type WorkspaceSplit } from "../../workspace/layout";
import { browserAnimationFrameHost, RafCoalescer } from "../../workspace/raf-coalescer";
import type { DockNodeProps } from "./DockNode";
import { DockNode } from "./DockNode";

export function DockSplit({ node, ...props }: DockNodeProps & { readonly node: WorkspaceSplit }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pendingRatio = useRef(node.ratio);
  const dragging = useRef(false);
  const coalescer = useMemo(
    () =>
      new RafCoalescer<number>(browserAnimationFrameHost(), (ratio) => {
        pendingRatio.current = ratio;
        const preview = previewRef.current;
        if (preview) preview.style.setProperty("--workspace-preview-ratio", String(ratio));
      }),
    [],
  );
  useEffect(() => () => coalescer.cancel(), [coalescer]);

  const ratioAtPointer = (event: PointerEvent): number => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return node.ratio;
    const raw =
      node.axis === "horizontal"
        ? (event.clientX - bounds.left) / bounds.width
        : (event.clientY - bounds.top) / bounds.height;
    return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, raw));
  };
  const commitKeyboardResize = (event: KeyboardEvent<HTMLHRElement>) => {
    const negative = node.axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const positive = node.axis === "horizontal" ? "ArrowRight" : "ArrowDown";
    if (
      event.key !== negative &&
      event.key !== positive &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const ratio =
      event.key === "Home"
        ? MIN_SPLIT_RATIO
        : event.key === "End"
          ? MAX_SPLIT_RATIO
          : node.ratio + (event.key === negative ? -0.02 : 0.02);
    props.onResize(node.id, ratio);
  };
  return (
    <div className={`workspace-split ${node.axis}`} ref={rootRef}>
      <div className="workspace-split-pane first" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <DockNode {...props} node={node.first} />
      </div>
      <hr
        aria-label={t("workspace.resizePanels")}
        aria-orientation={node.axis === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(node.ratio * 100)}
        className="workspace-splitter"
        onKeyDown={commitKeyboardResize}
        onPointerDown={(event) => {
          dragging.current = true;
          pendingRatio.current = node.ratio;
          previewRef.current?.classList.add("active");
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragging.current) coalescer.schedule(ratioAtPointer(event));
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          coalescer.schedule(ratioAtPointer(event));
          coalescer.flush();
          dragging.current = false;
          previewRef.current?.classList.remove("active");
          event.currentTarget.releasePointerCapture(event.pointerId);
          props.onResize(node.id, pendingRatio.current);
        }}
        tabIndex={0}
      />
      <div className="workspace-split-pane second">
        <DockNode {...props} node={node.second} />
      </div>
      <div aria-hidden="true" className={`workspace-split-preview ${node.axis}`} ref={previewRef} />
    </div>
  );
}
