import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GraphSampleBuffer } from "../core/graph-sampling";
import type { PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import type { Keyframe } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import {
  collectAnimatedGraphTracks,
  type GraphCurve,
  type GraphEasingPreview,
  type GraphKeyframePreview,
  type GraphTrack,
  type GraphType,
  graphCurveRange,
  graphCurveValue,
  graphCurveValueAtTime,
  graphDraggedKeyframeValue,
  previewGraphTrack,
  resolveGraphType,
  sampleGraphTrack,
} from "./graph-editor/model";
import {
  fitGraphTimeRange,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  type GraphTimeRange,
  type GraphValueRange,
  graphMarkerRadii,
  graphXToTime,
  graphYToValue,
  panGraphTimeRange,
  panGraphValueRange,
  snapGraphTime,
  timeToGraphX,
  valueToGraphY,
  zoomGraphTimeRange,
  zoomGraphValueRange,
} from "./graph-editor/viewport";

const POINTER_EPSILON = 0.000_001;

export { graphMarkerRadii } from "./graph-editor/viewport";

export function GraphEditor() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const sampleBuffers = useRef(new Map<PropertyPath, GraphSampleBuffer>());
  const gridId = useId().replace(/:/g, "");
  const composition = activeComposition(state.project);
  const layer = composition.layers.find((entry) => entry.id === state.selection[0]);
  const resetKey = `${layer?.id ?? ""}:${composition.duration}`;
  const resetKeyRef = useRef(resetKey);
  const tracks = useMemo(() => collectAnimatedGraphTracks(layer), [layer]);
  const [graphType, setGraphType] = useState<GraphType>("auto");
  const [hiddenTracks, setHiddenTracks] = useState<Set<PropertyPath>>(() => new Set());
  const [timeRange, setTimeRange] = useState<GraphTimeRange>(() => ({
    start: 0,
    end: Math.max(composition.duration, Number.EPSILON),
  }));
  const [manualValueRange, setManualValueRange] = useState<GraphValueRange>({ min: -1, max: 1 });
  const [autoZoomHeight, setAutoZoomHeight] = useState(true);
  const [keyframePreview, setKeyframePreview] = useState<GraphKeyframePreview>();
  const [easingPreview, setEasingPreview] = useState<GraphEasingPreview>();
  const [viewportSize, setViewportSize] = useState({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT });
  const frameDuration = composition.frameRate.denominator / composition.frameRate.numerator;

  useEffect(() => {
    if (resetKeyRef.current === resetKey) return;
    resetKeyRef.current = resetKey;
    sampleBuffers.current.clear();
    setHiddenTracks(new Set());
    setTimeRange({ start: 0, end: Math.max(composition.duration, Number.EPSILON) });
    setAutoZoomHeight(true);
    setKeyframePreview(undefined);
    setEasingPreview(undefined);
  }, [composition.duration, resetKey]);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateViewportSize = () => {
      const { width, height } = svg.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setViewportSize((current) =>
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height },
      );
    };
    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const displayedTracks = useMemo(
    () => tracks.map((track) => previewGraphTrack(track, keyframePreview, easingPreview)),
    [easingPreview, keyframePreview, tracks],
  );
  const visibleTracks = useMemo(
    () => displayedTracks.filter((track) => !hiddenTracks.has(track.id)),
    [displayedTracks, hiddenTracks],
  );
  const curves = useMemo(
    () =>
      visibleTracks.map((track) => {
        const curve = sampleGraphTrack(
          track,
          graphType,
          timeRange.start,
          timeRange.end,
          Math.max(1, viewportSize.width),
          sampleBuffers.current.get(track.id),
        );
        sampleBuffers.current.set(track.id, curve.samples);
        return curve;
      }),
    [graphType, timeRange.end, timeRange.start, viewportSize.width, visibleTracks],
  );
  const sampledValueRange = useMemo(() => graphCurveRange(curves), [curves]);
  const valueRange = autoZoomHeight ? sampledValueRange : manualValueRange;
  const keyRadii = graphMarkerRadii(viewportSize.width, viewportSize.height, 5);
  const handleRadii = graphMarkerRadii(viewportSize.width, viewportSize.height, 4);
  const pixelsPerSecond = viewportSize.width / Math.max(timeRange.end - timeRange.start, 1e-9);

  const updateKeyframe = (
    track: GraphTrack,
    keyframe: Keyframe,
    time: number,
    value: number,
    easing = keyframe.easing,
    interpolation = keyframe.interpolation,
  ) => {
    if (!layer || layer.locked) return;
    dispatch({
      type: "operation",
      operations: [
        {
          type: "updateKeyframe",
          layerId: layer.id,
          path: track.path,
          keyframeId: keyframe.id,
          time,
          value,
          interpolation,
          easing,
          spatialIn: keyframe.spatialIn,
          spatialOut: keyframe.spatialOut,
        },
      ],
    });
  };

  const scrub = (svg: SVGSVGElement, clientX: number, bypass: boolean) => {
    const bounds = svg.getBoundingClientRect();
    const point = clientGraphPoint(svg, clientX, bounds.top);
    const time = snapGraphTime(
      graphXToTime(point.x, timeRange),
      frameDuration,
      state.currentTime,
      pixelsPerSecond,
      bypass,
    );
    dispatch({ type: "setTime", time: Math.max(0, Math.min(composition.duration, time)) });
  };

  const startSurfacePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const initialTime = timeRange;
      const initialValue = valueRange;
      const startX = event.clientX;
      const startY = event.clientY;
      const move = (moveEvent: PointerEvent) => {
        const timeDelta =
          (-(moveEvent.clientX - startX) / Math.max(1, bounds.width)) *
          (initialTime.end - initialTime.start);
        const valueDelta =
          ((moveEvent.clientY - startY) / Math.max(1, bounds.height)) *
          (initialValue.max - initialValue.min);
        setTimeRange(panGraphTimeRange(initialTime, timeDelta, composition.duration));
        if (Math.abs(valueDelta) > POINTER_EPSILON) {
          setAutoZoomHeight(false);
          setManualValueRange(panGraphValueRange(initialValue, valueDelta));
        }
      };
      const end = () => removeWindowPointerListeners(move, end);
      addWindowPointerListeners(move, end);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    scrub(svg, event.clientX, event.ctrlKey || event.metaKey);
    const move = (moveEvent: PointerEvent) =>
      scrub(svg, moveEvent.clientX, moveEvent.ctrlKey || moveEvent.metaKey);
    const end = () => removeWindowPointerListeners(move, end);
    addWindowPointerListeners(move, end);
  };

  const startKeyframeDrag = (
    event: React.PointerEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
  ) => {
    if (event.button !== 0 || layer?.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    const sourceTrack = tracks.find((track) => track.id === curve.track.id);
    if (!svg || !sourceTrack) return;
    dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
    let next = {
      trackId: sourceTrack.id,
      keyframeId: keyframe.id,
      time: keyframe.time,
      value: keyframe.value,
    } satisfies GraphKeyframePreview;
    const move = (moveEvent: PointerEvent) => {
      const point = clientGraphPoint(svg, moveEvent.clientX, moveEvent.clientY);
      next = {
        ...next,
        time: Math.max(
          0,
          Math.min(
            composition.duration,
            snapGraphTime(
              graphXToTime(point.x, timeRange),
              frameDuration,
              state.currentTime,
              pixelsPerSecond,
              moveEvent.ctrlKey || moveEvent.metaKey,
            ),
          ),
        ),
        value: graphDraggedKeyframeValue(
          curve.type,
          keyframe.value,
          graphYToValue(point.y, valueRange),
        ),
      };
      setKeyframePreview(next);
    };
    const end = () => {
      removeWindowPointerListeners(move, end);
      setKeyframePreview(undefined);
      if (
        Math.abs(next.time - keyframe.time) > POINTER_EPSILON ||
        Math.abs(next.value - keyframe.value) > POINTER_EPSILON
      )
        updateKeyframe(sourceTrack, keyframe, next.time, next.value);
    };
    addWindowPointerListeners(move, end);
  };

  const startHandleDrag = (
    event: React.PointerEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
    nextKeyframe: Keyframe,
    handle: "out" | "in",
  ) => {
    if (curve.type !== "value" || event.button !== 0 || layer?.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    const sourceTrack = tracks.find((track) => track.id === curve.track.id);
    const sourceKeyframe = sourceTrack?.property.keyframes.find(
      (entry) => entry.id === keyframe.id,
    );
    if (!svg || !sourceTrack || !sourceKeyframe) return;
    const start = keyframePoint(keyframe, timeRange, valueRange);
    const finish = keyframePoint(nextKeyframe, timeRange, valueRange);
    let easing = keyframe.easing ?? [0.42, 0, 0.58, 1];
    const move = (moveEvent: PointerEvent) => {
      const point = clientGraphPoint(svg, moveEvent.clientX, moveEvent.clientY);
      const x = Math.max(0, Math.min(1, (point.x - start.x) / signedNonZero(finish.x - start.x)));
      const y = Math.max(-4, Math.min(5, (point.y - start.y) / signedNonZero(finish.y - start.y)));
      easing =
        handle === "out"
          ? [Math.min(x, easing[2]), y, easing[2], easing[3]]
          : [easing[0], easing[1], Math.max(x, easing[0]), y];
      setEasingPreview({ trackId: sourceTrack.id, keyframeId: keyframe.id, easing });
    };
    const end = () => {
      removeWindowPointerListeners(move, end);
      setEasingPreview(undefined);
      updateKeyframe(
        sourceTrack,
        sourceKeyframe,
        sourceKeyframe.time,
        sourceKeyframe.value,
        easing,
        "bezier",
      );
    };
    addWindowPointerListeners(move, end);
  };

  const keyboardEditKeyframe = (
    event: React.KeyboardEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
  ) => {
    const sourceTrack = tracks.find((track) => track.id === curve.track.id);
    if (!sourceTrack || layer?.locked) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
      return;
    }
    const timeDirection = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const valueDirection = event.key === "ArrowDown" ? -1 : event.key === "ArrowUp" ? 1 : 0;
    if (!timeDirection && (!valueDirection || curve.type === "speed")) return;
    event.preventDefault();
    event.stopPropagation();
    const multiplier = event.shiftKey ? 10 : 1;
    updateKeyframe(
      sourceTrack,
      keyframe,
      Math.max(
        0,
        Math.min(composition.duration, keyframe.time + timeDirection * frameDuration * multiplier),
      ),
      keyframe.value + valueDirection * sourceTrack.step * multiplier,
    );
  };

  const fitAll = () => {
    setTimeRange(fitGraphTimeRange(visibleTracks, composition.duration));
    setAutoZoomHeight(true);
  };
  const fitSelection = () => {
    setTimeRange(
      fitGraphTimeRange(visibleTracks, composition.duration, new Set(state.selectedKeyframes)),
    );
    setAutoZoomHeight(true);
  };
  const surfaceKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const frameDirection = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (frameDirection) {
      event.preventDefault();
      dispatch({
        type: "setTime",
        time: Math.max(
          0,
          Math.min(composition.duration, state.currentTime + frameDirection * frameDuration),
        ),
      });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      dispatch({ type: "setTime", time: event.key === "Home" ? 0 : composition.duration });
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      setTimeRange(
        zoomGraphTimeRange(
          timeRange,
          state.currentTime,
          event.key === "-" ? 1.25 : 0.8,
          composition.duration,
          frameDuration / 4,
        ),
      );
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      if (event.shiftKey) fitAll();
      else fitSelection();
    }
  };

  return (
    <div className="graph-editor">
      <div className="graph-sidebar">
        <strong>{layer?.name ?? t("graph.noSelection")}</strong>
        <div className="graph-track-list">
          {tracks.map((track) => {
            const visible = !hiddenTracks.has(track.id);
            const resolved = resolveGraphType(graphType, track);
            const label = t(track.labelKey);
            return (
              <button
                aria-label={t(visible ? "graph.track.hide" : "graph.track.show", { label })}
                aria-pressed={visible}
                className={visible ? "active" : ""}
                key={track.id}
                onClick={() =>
                  setHiddenTracks((current) => {
                    const next = new Set(current);
                    if (next.has(track.id)) next.delete(track.id);
                    else next.add(track.id);
                    return next;
                  })
                }
                type="button"
              >
                <span className="property-color" style={{ background: track.color }} />
                <span>{label}</span>
                <small>{t(resolved === "speed" ? "graph.badge.speed" : "graph.badge.value")}</small>
              </button>
            );
          })}
          {layer && tracks.length === 0 && (
            <span className="graph-empty">{t("graph.noAnimated")}</span>
          )}
        </div>
      </div>
      <div className="graph-main">
        <div className="graph-toolbar">
          <label>
            <span>{t("graph.type.label")}</span>
            <select
              aria-label={t("graph.type.label")}
              onChange={(event) => setGraphType(event.target.value as GraphType)}
              value={graphType}
            >
              <option value="auto">{t("graph.type.auto")}</option>
              <option value="value">{t("graph.type.value")}</option>
              <option value="speed">{t("graph.type.speed")}</option>
            </select>
          </label>
          <button disabled={!state.selectedKeyframes.length} onClick={fitSelection} type="button">
            {t("graph.fitSelection")}
          </button>
          <button disabled={!visibleTracks.length} onClick={fitAll} type="button">
            {t("graph.fitAll")}
          </button>
          <button
            aria-pressed={autoZoomHeight}
            className={autoZoomHeight ? "active" : ""}
            onClick={() => {
              if (autoZoomHeight) setManualValueRange(sampledValueRange);
              setAutoZoomHeight(!autoZoomHeight);
            }}
            type="button"
          >
            {t("graph.autoZoomHeight")}
          </button>
        </div>
        <div
          aria-label={t("graph.a11y")}
          className="graph-surface"
          onKeyDown={surfaceKeyDown}
          role="application"
          /* biome-ignore lint/a11y/noNoninteractiveTabindex: The graph canvas is an application-style keyboard interaction surface. */
          tabIndex={0}
        >
          <svg
            onPointerDown={startSurfacePointer}
            onWheel={(event) => {
              event.preventDefault();
              const point = clientGraphPoint(event.currentTarget, event.clientX, event.clientY);
              const factor = Math.exp(event.deltaY * 0.0015);
              if (event.altKey) {
                setTimeRange(
                  zoomGraphTimeRange(
                    timeRange,
                    graphXToTime(point.x, timeRange),
                    factor,
                    composition.duration,
                    frameDuration / 4,
                  ),
                );
              } else if (event.ctrlKey || event.metaKey) {
                const initial = valueRange;
                setAutoZoomHeight(false);
                setManualValueRange(
                  zoomGraphValueRange(initial, graphYToValue(point.y, initial), factor),
                );
              } else if (event.shiftKey) {
                setTimeRange(
                  panGraphTimeRange(
                    timeRange,
                    (event.deltaY / Math.max(1, viewportSize.width)) *
                      (timeRange.end - timeRange.start),
                    composition.duration,
                  ),
                );
              } else {
                const initial = valueRange;
                setAutoZoomHeight(false);
                setManualValueRange(
                  panGraphValueRange(
                    initial,
                    (event.deltaY / Math.max(1, viewportSize.height)) * (initial.max - initial.min),
                  ),
                );
              }
            }}
            preserveAspectRatio="none"
            ref={svgRef}
            viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
          >
            <title>{t("graph.a11y")}</title>
            <defs>
              <pattern height="26" id={gridId} patternUnits="userSpaceOnUse" width="50">
                <path
                  d="M 50 0 L 0 0 0 26"
                  fill="none"
                  stroke="rgba(255,255,255,.055)"
                  strokeWidth="1"
                />
              </pattern>
            </defs>
            <rect fill={`url(#${gridId})`} height={GRAPH_HEIGHT} width={GRAPH_WIDTH} />
            {curves.map((curve) => (
              <path
                aria-label={`${t(curve.track.labelKey)} · ${t(curve.type === "speed" ? "graph.type.speed" : "graph.type.value")}`}
                className="graph-curve"
                d={curvePath(curve, timeRange, valueRange)}
                fill="none"
                key={curve.track.id}
                pointerEvents="none"
                stroke={curve.track.color}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {curves.map((curve) =>
              curve.track.property.keyframes.map((keyframe, index) => {
                if (keyframe.time < timeRange.start || keyframe.time > timeRange.end) return null;
                const selected = state.selectedKeyframes.includes(keyframe.id);
                const point = {
                  x: timeToGraphX(keyframe.time, timeRange),
                  y: valueToGraphY(
                    curve.type === "value"
                      ? keyframe.value
                      : graphCurveValueAtTime(curve, keyframe.time),
                    valueRange,
                  ),
                };
                const next = curve.track.property.keyframes[index + 1];
                const easing =
                  easingPreview?.trackId === curve.track.id &&
                  easingPreview.keyframeId === keyframe.id
                    ? easingPreview.easing
                    : (keyframe.easing ?? [0.42, 0, 0.58, 1]);
                const nextPoint = next ? keyframePoint(next, timeRange, valueRange) : undefined;
                const outHandle = nextPoint
                  ? interpolatePoint(point, nextPoint, easing[0], easing[1])
                  : undefined;
                const inHandle = nextPoint
                  ? interpolatePoint(point, nextPoint, easing[2], easing[3])
                  : undefined;
                const label = t(curve.track.labelKey);
                return (
                  <g key={`${curve.track.id}:${keyframe.id}`}>
                    {curve.type === "value" && selected && next && outHandle && inHandle && (
                      <>
                        <line
                          className="graph-handle-line"
                          style={{ stroke: curve.track.color }}
                          x1={point.x}
                          x2={outHandle.x}
                          y1={point.y}
                          y2={outHandle.y}
                        />
                        <line
                          className="graph-handle-line"
                          style={{ stroke: curve.track.color }}
                          x1={nextPoint?.x}
                          x2={inHandle.x}
                          y1={nextPoint?.y}
                          y2={inHandle.y}
                        />
                        <ellipse
                          aria-label={t("graph.handle.outgoing", { label })}
                          className="graph-handle"
                          cx={outHandle.x}
                          cy={outHandle.y}
                          onPointerDown={(event) =>
                            startHandleDrag(event, curve, keyframe, next, "out")
                          }
                          rx={handleRadii.x}
                          ry={handleRadii.y}
                          style={{ stroke: curve.track.color }}
                        />
                        <ellipse
                          aria-label={t("graph.handle.incoming", { label })}
                          className="graph-handle"
                          cx={inHandle.x}
                          cy={inHandle.y}
                          onPointerDown={(event) =>
                            startHandleDrag(event, curve, keyframe, next, "in")
                          }
                          rx={handleRadii.x}
                          ry={handleRadii.y}
                          style={{ stroke: curve.track.color }}
                        />
                      </>
                    )}
                    {/* biome-ignore lint/a11y/useSemanticElements: SVG keyframe geometry cannot be an HTML button. */}
                    <ellipse
                      aria-label={t("graph.keyframe", {
                        label,
                        time: keyframe.time.toFixed(3),
                        value: keyframe.value.toFixed(3),
                      })}
                      className={selected ? "graph-key selected" : "graph-key"}
                      cx={point.x}
                      cy={point.y}
                      onKeyDown={(event) => keyboardEditKeyframe(event, curve, keyframe)}
                      onPointerDown={(event) => startKeyframeDrag(event, curve, keyframe)}
                      role="button"
                      rx={keyRadii.x}
                      ry={keyRadii.y}
                      style={{ stroke: curve.track.color }}
                      tabIndex={0}
                    />
                  </g>
                );
              }),
            )}
            <line
              className="graph-playhead"
              x1={timeToGraphX(state.currentTime, timeRange)}
              x2={timeToGraphX(state.currentTime, timeRange)}
              y1="0"
              y2={GRAPH_HEIGHT}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

function curvePath(
  curve: GraphCurve,
  timeRange: GraphTimeRange,
  valueRange: GraphValueRange,
): string {
  let path = "";
  let connected = false;
  for (let index = 0; index < curve.samples.count; index += 1) {
    if (!curve.samples.validity[index]) {
      connected = false;
      continue;
    }
    const x = timeToGraphX(curve.samples.times[index], timeRange);
    const y = valueToGraphY(graphCurveValue(curve, index), valueRange);
    path += `${connected ? "L" : "M"}${roundPath(x)} ${roundPath(y)}`;
    connected = true;
  }
  return path;
}

function keyframePoint(
  keyframe: Pick<Keyframe, "time" | "value">,
  timeRange: GraphTimeRange,
  valueRange: GraphValueRange,
) {
  return {
    x: timeToGraphX(keyframe.time, timeRange),
    y: valueToGraphY(keyframe.value, valueRange),
  };
}

function clientGraphPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const bounds = svg.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  return {
    x: Math.max(0, Math.min(GRAPH_WIDTH, ((clientX - bounds.left) / width) * GRAPH_WIDTH)),
    y: Math.max(0, Math.min(GRAPH_HEIGHT, ((clientY - bounds.top) / height) * GRAPH_HEIGHT)),
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
  if (Math.abs(value) > POINTER_EPSILON) return value;
  return value < 0 ? -1 : 1;
}

function roundPath(value: number): number {
  return Math.round(value * 100) / 100;
}

function addWindowPointerListeners(move: (event: PointerEvent) => void, end: () => void): void {
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function removeWindowPointerListeners(move: (event: PointerEvent) => void, end: () => void): void {
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", end);
  window.removeEventListener("pointercancel", end);
}
