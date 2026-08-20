import { useState } from "react";
import { activeComposition } from "../core/project";
import { evaluateAnimatable } from "../core/timeline";
import type { Keyframe } from "../core/types";
import { useEditor } from "../state/editor-store";

const WIDTH = 1000;
const HEIGHT = 260;
const PADDING = 30;

interface KeyframePreview {
  id: string;
  time: number;
  value: number;
}

interface EasingPreview {
  id: string;
  easing: [number, number, number, number];
}

export function GraphEditor() {
  const { state, dispatch } = useEditor();
  const composition = activeComposition(state.project);
  const layer = composition.layers.find((entry) => entry.id === state.selection[0]);
  const property = layer?.transform.position[1];
  const keyframes = property?.mode === "animated" ? property.keyframes : [];
  const [keyframePreview, setKeyframePreview] = useState<KeyframePreview>();
  const [easingPreview, setEasingPreview] = useState<EasingPreview>();
  const displayed = keyframes.map((keyframe) => {
    const positioned =
      keyframePreview?.id === keyframe.id ? { ...keyframe, ...keyframePreview } : keyframe;
    return easingPreview?.id === keyframe.id
      ? { ...positioned, interpolation: "bezier" as const, easing: easingPreview.easing }
      : positioned;
  });
  const values = displayed.map((keyframe) => keyframe.value);
  const rawMin = Math.min(...values, 0);
  const rawMax = Math.max(...values, 1);
  const padding = Math.max(1, (rawMax - rawMin) * 0.08);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const position = (keyframe: Keyframe) => ({
    x: (keyframe.time / composition.duration) * WIDTH,
    y: HEIGHT - ((keyframe.value - min) / (max - min)) * (HEIGHT - PADDING * 2) - PADDING,
  });
  const curve = { mode: "animated" as const, keyframes: displayed };
  const points = Array.from({ length: 241 }, (_, index) => {
    const time = (index / 240) * composition.duration;
    const point = position({ time, value: evaluateAnimatable(curve, time) } as Keyframe);
    return `${point.x},${point.y}`;
  }).join(" ");

  const updateKeyframe = (
    keyframe: Keyframe,
    time: number,
    value: number,
    easing = keyframe.easing,
  ) => {
    if (!layer) return;
    dispatch({
      type: "operation",
      operations: [
        {
          type: "updateKeyframe",
          layerId: layer.id,
          path: "position.1",
          keyframeId: keyframe.id,
          time,
          value,
          interpolation: keyframe.interpolation,
          easing,
        },
      ],
    });
  };

  const startKeyframeDrag = (event: React.PointerEvent<SVGCircleElement>, keyframe: Keyframe) => {
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    let next = { id: keyframe.id, time: keyframe.time, value: keyframe.value };
    const move = (moveEvent: PointerEvent) => {
      const point = graphPoint(svg, moveEvent.clientX, moveEvent.clientY);
      const frame = composition.frameRate.denominator / composition.frameRate.numerator;
      next = {
        id: keyframe.id,
        time: Math.max(
          0,
          Math.min(
            composition.duration,
            Math.round(((point.x / WIDTH) * composition.duration) / frame) * frame,
          ),
        ),
        value: min + ((HEIGHT - PADDING - point.y) / (HEIGHT - PADDING * 2)) * (max - min),
      };
      setKeyframePreview(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setKeyframePreview(undefined);
      updateKeyframe(keyframe, next.time, next.value);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startHandleDrag = (
    event: React.PointerEvent<SVGCircleElement>,
    keyframe: Keyframe,
    nextKeyframe: Keyframe,
    handle: "out" | "in",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const start = position(keyframe);
    const end = position(nextKeyframe);
    let easing =
      easingPreview?.id === keyframe.id
        ? easingPreview.easing
        : (keyframe.easing ?? [0.42, 0, 0.58, 1]);
    const move = (moveEvent: PointerEvent) => {
      const point = graphPoint(svg, moveEvent.clientX, moveEvent.clientY);
      const x = Math.max(0, Math.min(1, (point.x - start.x) / Math.max(1, end.x - start.x)));
      const y = Math.max(-2, Math.min(3, (point.y - start.y) / signedNonZero(end.y - start.y)));
      easing =
        handle === "out"
          ? [Math.min(x, easing[2]), y, easing[2], easing[3]]
          : [easing[0], easing[1], Math.max(x, easing[0]), y];
      setEasingPreview({ id: keyframe.id, easing });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setEasingPreview(undefined);
      if (!layer) return;
      dispatch({
        type: "operation",
        operations: [
          {
            type: "updateKeyframe",
            layerId: layer.id,
            path: "position.1",
            keyframeId: keyframe.id,
            time: keyframe.time,
            value: keyframe.value,
            interpolation: "bezier",
            easing,
          },
        ],
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="graph-editor">
      <div className="graph-sidebar">
        <strong>{layer?.name ?? "No selection"}</strong>
        <button
          className="active"
          onClick={() => {
            if (keyframes[0]) dispatch({ type: "setTime", time: keyframes[0].time });
          }}
          title="Focus and edit Y Position curve"
          type="button"
        >
          <span className="property-color" /> Y Position
        </button>
        <small>Drag keys · drag handles for easing</small>
      </div>
      <svg
        aria-label="Editable Y Position keyframe value graph"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <defs>
          <pattern height="26" id="graph-grid" patternUnits="userSpaceOnUse" width="50">
            <path
              d="M 50 0 L 0 0 0 26"
              fill="none"
              stroke="rgba(255,255,255,.055)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect fill="url(#graph-grid)" height={HEIGHT} width={WIDTH} />
        {points && (
          <polyline
            fill="none"
            points={points}
            stroke="#68a0ff"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {displayed.map((keyframe, index) => {
          const point = position(keyframe);
          const next = displayed[index + 1];
          const selected = state.selectedKeyframes.includes(keyframe.id);
          const easing =
            easingPreview?.id === keyframe.id
              ? easingPreview.easing
              : (keyframe.easing ?? [0.42, 0, 0.58, 1]);
          const nextPoint = next ? position(next) : undefined;
          const outHandle = nextPoint
            ? interpolatePoint(point, nextPoint, easing[0], easing[1])
            : undefined;
          const inHandle = nextPoint
            ? interpolatePoint(point, nextPoint, easing[2], easing[3])
            : undefined;
          return (
            <g key={keyframe.id}>
              {selected && next && outHandle && inHandle && (
                <>
                  <line
                    className="graph-handle-line"
                    x1={point.x}
                    x2={outHandle.x}
                    y1={point.y}
                    y2={outHandle.y}
                  />
                  <line
                    className="graph-handle-line"
                    x1={nextPoint?.x}
                    x2={inHandle.x}
                    y1={nextPoint?.y}
                    y2={inHandle.y}
                  />
                  <circle
                    className="graph-handle"
                    cx={outHandle.x}
                    cy={outHandle.y}
                    onPointerDown={(event) => startHandleDrag(event, keyframe, next, "out")}
                    r="4"
                  />
                  <circle
                    className="graph-handle"
                    cx={inHandle.x}
                    cy={inHandle.y}
                    onPointerDown={(event) => startHandleDrag(event, keyframe, next, "in")}
                    r="4"
                  />
                </>
              )}
              <circle
                className={selected ? "graph-key selected" : "graph-key"}
                cx={point.x}
                cy={point.y}
                onPointerDown={(event) => startKeyframeDrag(event, keyframe)}
                r="5"
              />
            </g>
          );
        })}
        <line
          className="graph-playhead"
          x1={(state.currentTime / composition.duration) * WIDTH}
          x2={(state.currentTime / composition.duration) * WIDTH}
          y1="0"
          y2={HEIGHT}
        />
      </svg>
    </div>
  );
}

function graphPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const bounds = svg.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(WIDTH, ((clientX - bounds.left) / bounds.width) * WIDTH)),
    y: Math.max(0, Math.min(HEIGHT, ((clientY - bounds.top) / bounds.height) * HEIGHT)),
  };
}

function interpolatePoint(
  start: { x: number; y: number },
  end: { x: number; y: number },
  x: number,
  y: number,
) {
  return { x: start.x + (end.x - start.x) * x, y: start.y + (end.y - start.y) * y };
}

function signedNonZero(value: number): number {
  if (Math.abs(value) > 0.000_001) return value;
  return value < 0 ? -1 : 1;
}
