import { useState } from "react";
import type { Composition, Layer } from "../core/types";
import { useEditor } from "../state/editor-store";

type TimingDrag = "move" | "trim-in" | "trim-out";

export function LayerTimingBar({
  composition,
  layer,
  pixelsPerSecond,
}: {
  composition: Composition;
  layer: Layer;
  pixelsPerSecond: number;
}) {
  const { dispatch } = useEditor();
  const [preview, setPreview] = useState<{ inPoint: number; outPoint: number }>();
  const timing = preview ?? layer;
  const startDrag = (event: React.PointerEvent, mode: TimingDrag) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const initial = { inPoint: layer.inPoint, outPoint: layer.outPoint };
    let next = initial;
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) / pixelsPerSecond;
      next = retimeLayer(initial, mode, delta, composition);
      setPreview(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPreview(undefined);
      if (
        Math.abs(next.inPoint - initial.inPoint) < 0.000_001 &&
        Math.abs(next.outPoint - initial.outPoint) < 0.000_001
      )
        return;
      dispatch({
        type: "operation",
        operations: [
          {
            type: "setLayerTiming",
            layerId: layer.id,
            inPoint: next.inPoint,
            outPoint: next.outPoint,
          },
        ],
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`layer-bar kind-${layer.kind}`}
      onPointerDown={(event) => startDrag(event, "move")}
      style={{
        left: timing.inPoint * pixelsPerSecond,
        width: Math.max(2, (timing.outPoint - timing.inPoint) * pixelsPerSecond),
      }}
      title={`${layer.name} · drag to move · use edge handles to trim`}
    >
      <button
        aria-label={`Trim ${layer.name} in point`}
        className="timing-handle start"
        onPointerDown={(event) => startDrag(event, "trim-in")}
        type="button"
      />
      <span>{layer.name}</span>
      <button
        aria-label={`Trim ${layer.name} out point`}
        className="timing-handle end"
        onPointerDown={(event) => startDrag(event, "trim-out")}
        type="button"
      />
    </div>
  );
}

function retimeLayer(
  initial: { inPoint: number; outPoint: number },
  mode: TimingDrag,
  delta: number,
  composition: Composition,
) {
  const frame = composition.frameRate.denominator / composition.frameRate.numerator;
  const snap = (time: number) => Math.round(time / frame) * frame;
  if (mode === "trim-in") {
    return {
      inPoint: Math.max(0, Math.min(initial.outPoint - frame, snap(initial.inPoint + delta))),
      outPoint: initial.outPoint,
    };
  }
  if (mode === "trim-out") {
    return {
      inPoint: initial.inPoint,
      outPoint: Math.min(
        composition.duration,
        Math.max(initial.inPoint + frame, snap(initial.outPoint + delta)),
      ),
    };
  }
  const duration = initial.outPoint - initial.inPoint;
  const inPoint = Math.max(
    0,
    Math.min(composition.duration - duration, snap(initial.inPoint + delta)),
  );
  return { inPoint, outPoint: inPoint + duration };
}
