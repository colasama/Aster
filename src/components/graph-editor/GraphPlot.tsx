import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  RefObject,
} from "react";
import type { Keyframe } from "../../core/types";
import type { Translate } from "../../i18n/core";
import {
  type GraphCurve,
  type GraphEasingPreview,
  graphCurveValue,
  graphCurveValueAtTime,
  graphSpeedSegment,
  graphTrackSegmentBaseSpeed,
} from "./model";
import {
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  type GraphTimeRange,
  type GraphValueRange,
  timeToGraphX,
  valueToGraphY,
} from "./viewport";

interface GraphPlotProps {
  currentTime: number;
  curves: readonly GraphCurve[];
  easingPreview?: GraphEasingPreview;
  gridId: string;
  handleRadii: { x: number; y: number };
  keyRadii: { x: number; y: number };
  layerBounds: ReadonlyArray<{ id: string; inPoint: number; outPoint: number }>;
  onHandlePointerDown: (
    event: ReactPointerEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
    nextKeyframe: Keyframe,
    handle: "out" | "in",
  ) => void;
  onKeyframeContextMenu: (
    event: ReactMouseEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
    selected: boolean,
  ) => void;
  onKeyframeKeyDown: (
    event: ReactKeyboardEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
    selected: boolean,
  ) => void;
  onKeyframePointerDown: (
    event: ReactPointerEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
  ) => void;
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onWheel: (event: ReactWheelEvent<SVGSVGElement>) => void;
  referenceCurves: readonly GraphCurve[];
  referenceValueRange: GraphValueRange;
  selectedKeyframeIds: ReadonlySet<string>;
  selectedKeyframeOwners: Readonly<Record<string, string>>;
  showLayerBounds: boolean;
  svgRef: RefObject<SVGSVGElement | null>;
  t: Translate;
  timeRange: GraphTimeRange;
  trackLabel: (curve: GraphCurve) => string;
  valueRange: GraphValueRange;
}

export function GraphPlot({
  currentTime,
  curves,
  easingPreview,
  gridId,
  handleRadii,
  keyRadii,
  layerBounds,
  onHandlePointerDown,
  onKeyframeContextMenu,
  onKeyframeKeyDown,
  onKeyframePointerDown,
  onPointerDown,
  onWheel,
  referenceCurves,
  referenceValueRange,
  selectedKeyframeIds,
  selectedKeyframeOwners,
  showLayerBounds,
  svgRef,
  t,
  timeRange,
  trackLabel,
  valueRange,
}: GraphPlotProps) {
  return (
    <svg
      onPointerDown={onPointerDown}
      onWheel={onWheel}
      preserveAspectRatio="none"
      ref={svgRef}
      viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
    >
      <title>{t("graph.a11y")}</title>
      <defs>
        <pattern height="26" id={gridId} patternUnits="userSpaceOnUse" width="50">
          <path d="M 50 0 L 0 0 0 26" fill="none" stroke="rgba(255,255,255,.055)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect fill={`url(#${gridId})`} height={GRAPH_HEIGHT} width={GRAPH_WIDTH} />
      {referenceCurves.map((curve) => (
        <path
          className="graph-reference-curve"
          d={curvePath(curve, timeRange, referenceValueRange)}
          fill="none"
          key={`reference:${curve.track.id}`}
          pointerEvents="none"
          stroke={curve.track.color}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {showLayerBounds &&
        layerBounds.map((entry) => (
          <g key={`bounds:${entry.id}`}>
            <line
              className="graph-layer-bound"
              x1={timeToGraphX(entry.inPoint, timeRange)}
              x2={timeToGraphX(entry.inPoint, timeRange)}
              y1="0"
              y2={GRAPH_HEIGHT}
            />
            <line
              className="graph-layer-bound"
              x1={timeToGraphX(entry.outPoint, timeRange)}
              x2={timeToGraphX(entry.outPoint, timeRange)}
              y1="0"
              y2={GRAPH_HEIGHT}
            />
          </g>
        ))}
      {curves.map((curve) => (
        <path
          aria-label={`${trackLabel(curve)} · ${t(curve.type === "speed" ? "graph.type.speed" : "graph.type.value")}`}
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
          const selected = isSelected(
            selectedKeyframeIds,
            selectedKeyframeOwners,
            curve.track.id,
            keyframe.id,
          );
          const point = {
            x: timeToGraphX(keyframe.time, timeRange),
            y: valueToGraphY(
              curve.type === "value" ? keyframe.value : graphCurveValueAtTime(curve, keyframe.time),
              valueRange,
            ),
          };
          const next = curve.track.property.keyframes[index + 1];
          const easing =
            easingPreview?.trackId === curve.track.id && easingPreview.keyframeId === keyframe.id
              ? easingPreview.easing
              : (keyframe.easing ?? [0.42, 0, 0.58, 1]);
          const nextPoint = next
            ? {
                x: timeToGraphX(next.time, timeRange),
                y: valueToGraphY(
                  curve.type === "value" ? next.value : graphCurveValueAtTime(curve, next.time),
                  valueRange,
                ),
              }
            : undefined;
          const speed = next
            ? graphSpeedSegment(
                { ...keyframe, easing },
                next,
                graphTrackSegmentBaseSpeed(curve.track, keyframe, next),
              )
            : undefined;
          const outHandle =
            next && nextPoint
              ? curve.type === "value"
                ? interpolatePoint(point, nextPoint, easing[0], easing[1])
                : {
                    x: timeToGraphX(
                      keyframe.time +
                        (next.time - keyframe.time) * (speed?.outgoingInfluence ?? 0.3333),
                      timeRange,
                    ),
                    y: valueToGraphY(speed?.outgoingSpeed ?? 0, valueRange),
                  }
              : undefined;
          const inHandle =
            next && nextPoint
              ? curve.type === "value"
                ? interpolatePoint(point, nextPoint, easing[2], easing[3])
                : {
                    x: timeToGraphX(
                      next.time -
                        (next.time - keyframe.time) * (speed?.incomingInfluence ?? 0.3333),
                      timeRange,
                    ),
                    y: valueToGraphY(speed?.incomingSpeed ?? 0, valueRange),
                  }
              : undefined;
          const label = trackLabel(curve);
          const nextSelected = Boolean(
            next &&
              isSelected(selectedKeyframeIds, selectedKeyframeOwners, curve.track.id, next.id),
          );
          return (
            <g key={`${curve.track.id}:${keyframe.id}`}>
              {keyframe.interpolation === "bezier" &&
                (selected || nextSelected) &&
                next &&
                nextPoint &&
                outHandle &&
                inHandle && (
                  <>
                    {selected && (
                      <>
                        <line
                          className="graph-handle-line"
                          style={{ stroke: curve.track.color }}
                          x1={point.x}
                          x2={outHandle.x}
                          y1={point.y}
                          y2={outHandle.y}
                        />
                        <ellipse
                          aria-label={t("graph.handle.outgoing", { label })}
                          className="graph-handle"
                          cx={outHandle.x}
                          cy={outHandle.y}
                          onPointerDown={(event) =>
                            onHandlePointerDown(event, curve, keyframe, next, "out")
                          }
                          rx={handleRadii.x}
                          ry={handleRadii.y}
                          style={{ stroke: curve.track.color }}
                        />
                      </>
                    )}
                    {nextSelected && (
                      <>
                        <line
                          className="graph-handle-line"
                          style={{ stroke: curve.track.color }}
                          x1={nextPoint.x}
                          x2={inHandle.x}
                          y1={nextPoint.y}
                          y2={inHandle.y}
                        />
                        <ellipse
                          aria-label={t("graph.handle.incoming", { label })}
                          className="graph-handle"
                          cx={inHandle.x}
                          cy={inHandle.y}
                          onPointerDown={(event) =>
                            onHandlePointerDown(event, curve, keyframe, next, "in")
                          }
                          rx={handleRadii.x}
                          ry={handleRadii.y}
                          style={{ stroke: curve.track.color }}
                        />
                      </>
                    )}
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
                onContextMenu={(event) => onKeyframeContextMenu(event, curve, keyframe, selected)}
                onKeyDown={(event) => onKeyframeKeyDown(event, curve, keyframe, selected)}
                onPointerDown={(event) => onKeyframePointerDown(event, curve, keyframe)}
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
        x1={timeToGraphX(currentTime, timeRange)}
        x2={timeToGraphX(currentTime, timeRange)}
        y1="0"
        y2={GRAPH_HEIGHT}
      />
    </svg>
  );
}

function isSelected(
  selectedIds: ReadonlySet<string>,
  owners: Readonly<Record<string, string>>,
  trackId: string,
  keyframeId: string,
): boolean {
  return selectedIds.has(keyframeId) && (!owners[keyframeId] || owners[keyframeId] === trackId);
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

function interpolatePoint(
  start: { x: number; y: number },
  end: { x: number; y: number },
  x: number,
  y: number,
) {
  return { x: start.x + (end.x - start.x) * x, y: start.y + (end.y - start.y) * y };
}

function roundPath(value: number): number {
  return Math.round(value * 100) / 100;
}
