import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Film,
  Gauge,
  GripVertical,
  KeyRound,
  Layers3,
  Lock,
  LockOpen,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { frameAt } from "../core/timeline";
import type { Animatable, Keyframe, Layer } from "../core/types";
import { useEditor } from "../state/editor-store";
import { Panel, PanelTabs } from "./Panel";

const LABEL_WIDTH = 286;
const BASE_PIXELS_PER_SECOND = 82;

type TimelineKeyframeEntry =
  | { source: "transform"; keyframe: Keyframe; path: PropertyPath; label: string }
  | {
      source: "effect";
      keyframe: Keyframe;
      effectId: string;
      parameter: string;
      label: string;
    };

export function Timeline() {
  const { state, dispatch } = useEditor();
  const composition = activeComposition(state.project);
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * state.timelineZoom;
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragLayer = useRef<string | undefined>(undefined);
  usePlayback(composition.duration);
  const ticks = useMemo(
    () => Array.from({ length: Math.floor(composition.duration * 2) + 1 }, (_, index) => index / 2),
    [composition.duration],
  );
  const scrub = (clientX: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const time = (clientX - bounds.left + scroll.scrollLeft - LABEL_WIDTH) / pixelsPerSecond;
    dispatch({ type: "setTime", time: Math.max(0, Math.min(composition.duration, time)) });
  };
  return (
    <Panel
      className="timeline-panel"
      tabs={
        <PanelTabs
          active={state.bottomMode}
          onChange={(mode) =>
            dispatch({ type: "setBottomMode", mode: mode as "timeline" | "graph" })
          }
          tabs={[
            { id: "timeline", label: "Timeline" },
            { id: "graph", label: "Graph Editor" },
          ]}
        />
      }
      actions={
        <>
          <button
            className={state.showLayerControls ? "active" : ""}
            onClick={() => dispatch({ type: "toggleView", view: "layerControls" })}
            title="Toggle layer switches"
            type="button"
          >
            <SlidersHorizontal size={13} />
          </button>
          <button
            onClick={() => toggleTimelineFullscreen()}
            title="Toggle fullscreen timeline"
            type="button"
          >
            <Maximize2 size={13} />
          </button>
        </>
      }
    >
      <div className="timeline-transport">
        <div className="timecode">
          <strong>{formatTimecode(state.currentTime, composition.frameRate)}</strong>
          <small>{frameAt(state.currentTime, composition.frameRate)}f</small>
        </div>
        <div className="transport-controls">
          <button onClick={() => dispatch({ type: "setTime", time: 0 })} type="button">
            <SkipBack size={14} />
          </button>
          <button
            className="play"
            onClick={() => dispatch({ type: "setPlaying", playing: !state.playing })}
            type="button"
          >
            {state.playing ? (
              <Pause fill="currentColor" size={14} />
            ) : (
              <Play fill="currentColor" size={14} />
            )}
          </button>
          <button
            onClick={() => dispatch({ type: "setTime", time: composition.duration })}
            type="button"
          >
            <SkipForward size={14} />
          </button>
        </div>
        <div className="timeline-options">
          <span>
            <Gauge size={12} /> 60 fps
          </span>
          <button
            onClick={() => dispatch({ type: "setTimelineZoom", zoom: state.timelineZoom / 1.25 })}
            type="button"
          >
            <ZoomOut size={13} />
          </button>
          <input
            max="8"
            min="0.5"
            onChange={(event) =>
              dispatch({ type: "setTimelineZoom", zoom: Number(event.target.value) })
            }
            step="0.1"
            type="range"
            value={state.timelineZoom}
          />
          <button
            onClick={() => dispatch({ type: "setTimelineZoom", zoom: state.timelineZoom * 1.25 })}
            type="button"
          >
            <ZoomIn size={13} />
          </button>
        </div>
      </div>
      {state.bottomMode === "graph" ? (
        <GraphEditor />
      ) : (
        <div className="timeline-scroll" ref={scrollRef}>
          <div
            className="timeline-canvas"
            style={{ width: LABEL_WIDTH + composition.duration * pixelsPerSecond }}
          >
            <div className="layer-column-header">
              <span>Source name</span>
              <div>
                <Eye size={11} />
                <Volume2 size={11} />
                <Lock size={11} />
                <Box size={11} />
              </div>
            </div>
            <div
              className="time-ruler"
              onPointerDown={(event) => {
                scrub(event.clientX);
                const move = (moveEvent: PointerEvent) => scrub(moveEvent.clientX);
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
              style={{ left: LABEL_WIDTH, width: composition.duration * pixelsPerSecond }}
            >
              {ticks.map((time) => (
                <div
                  className={Number.isInteger(time) ? "major tick" : "tick"}
                  key={time}
                  style={{ left: time * pixelsPerSecond }}
                >
                  <span>{Number.isInteger(time) ? formatSeconds(time) : ""}</span>
                </div>
              ))}
              <div
                className="work-area"
                style={{ left: 0, width: composition.duration * pixelsPerSecond }}
              />
            </div>
            <div className="layer-rows">
              {composition.layers.map((layer, index) => (
                <TimelineLayer
                  index={index}
                  key={layer.id}
                  layer={layer}
                  onDragStart={() => {
                    dragLayer.current = layer.id;
                  }}
                  onDrop={() => {
                    if (dragLayer.current && dragLayer.current !== layer.id)
                      dispatch({
                        type: "operation",
                        operations: [{ type: "reorderLayer", layerId: dragLayer.current, index }],
                      });
                    dragLayer.current = undefined;
                  }}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={state.selection.includes(layer.id)}
                />
              ))}
            </div>
            <div
              className="playhead"
              style={{ left: LABEL_WIDTH + state.currentTime * pixelsPerSecond }}
            >
              <span />
              <i />
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function TimelineLayer({
  layer,
  index,
  selected,
  pixelsPerSecond,
  onDragStart,
  onDrop,
}: {
  layer: Layer;
  index: number;
  selected: boolean;
  pixelsPerSecond: number;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const { state, dispatch } = useEditor();
  const [expanded, setExpanded] = useState(selected && layer.name === "ASTER");
  const keyframes = collectKeyframes(layer);
  const effectTracks = collectEffectTracks(layer);
  const Icon =
    layer.kind === "text"
      ? Type
      : layer.kind === "video"
        ? Film
        : layer.kind === "camera"
          ? Layers3
          : layer.kind === "particle"
            ? Gauge
            : Box;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Native drag-and-drop requires row-level handlers.
    <div
      className={`timeline-layer ${selected ? "selected" : ""}`}
      draggable
      onDragOver={(event) => event.preventDefault()}
      onDragStart={onDragStart}
      onDrop={onDrop}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: This control contains independent layer-switch buttons. */}
      <div
        className="layer-label"
        onClick={(event) => {
          const ids = event.shiftKey
            ? state.selection.includes(layer.id)
              ? state.selection.filter((id) => id !== layer.id)
              : [...state.selection, layer.id]
            : [layer.id];
          dispatch({ type: "select", ids });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", ids: [layer.id] });
          }
        }}
        role="button"
        tabIndex={0}
      >
        <GripVertical className="drag-handle" size={11} />
        <button
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(!expanded);
          }}
          type="button"
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        <span className={`layer-index color-${index % 6}`}>{index + 1}</span>
        <Icon size={13} />
        <strong>{layer.name}</strong>
        {state.showLayerControls && (
          <div className="layer-switches">
            <button
              onClick={(event) => {
                event.stopPropagation();
                dispatch({
                  type: "operation",
                  operations: [{ type: "toggleLayer", layerId: layer.id, field: "visible" }],
                });
              }}
              type="button"
            >
              {layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
            </button>
            <button
              disabled={layer.kind !== "video"}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({
                  type: "operation",
                  operations: [{ type: "toggleLayer", layerId: layer.id, field: "audioEnabled" }],
                });
              }}
              title={layer.kind === "video" ? "Toggle layer audio" : "This layer has no audio"}
              type="button"
            >
              {layer.audioEnabled === false ? <VolumeX size={11} /> : <Volume2 size={11} />}
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                dispatch({
                  type: "operation",
                  operations: [{ type: "toggleLayer", layerId: layer.id, field: "locked" }],
                });
              }}
              type="button"
            >
              {layer.locked ? <Lock size={11} /> : <LockOpen size={11} />}
            </button>
            <button
              className={layer.threeDimensional ? "enabled" : ""}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({
                  type: "operation",
                  operations: [
                    { type: "toggleLayer", layerId: layer.id, field: "threeDimensional" },
                  ],
                });
              }}
              type="button"
            >
              <Box size={11} />
            </button>
          </div>
        )}
      </div>
      <div className="layer-track" style={{ left: LABEL_WIDTH }}>
        <div
          className={`layer-bar kind-${layer.kind}`}
          style={{
            left: layer.inPoint * pixelsPerSecond,
            width: Math.max(2, (layer.outPoint - layer.inPoint) * pixelsPerSecond),
          }}
        >
          <span>{layer.name}</span>
        </div>
        {keyframes.map((entry) => (
          <button
            className={`keyframe ${entry.source === "effect" ? "effect-key" : ""}`}
            key={`${entry.source}:${entry.keyframe.id}`}
            onClick={() => dispatch({ type: "setTime", time: entry.keyframe.time })}
            onContextMenu={(event) => {
              event.preventDefault();
              dispatch({
                type: "operation",
                operations: [
                  entry.source === "transform"
                    ? {
                        type: "removeKeyframe",
                        layerId: layer.id,
                        path: entry.path,
                        keyframeId: entry.keyframe.id,
                      }
                    : {
                        type: "removeEffectParameterKeyframe",
                        layerId: layer.id,
                        effectId: entry.effectId,
                        parameter: entry.parameter,
                        keyframeId: entry.keyframe.id,
                      },
                ],
              });
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              const startX = event.clientX;
              const initialTime = entry.keyframe.time;
              let nextTime = initialTime;
              const move = (moveEvent: PointerEvent) => {
                nextTime = Math.max(
                  0,
                  initialTime + (moveEvent.clientX - startX) / pixelsPerSecond,
                );
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                if (Math.abs(nextTime - initialTime) < 0.001) return;
                dispatch({
                  type: "operation",
                  operations: [
                    entry.source === "transform"
                      ? {
                          type: "moveKeyframe",
                          layerId: layer.id,
                          path: entry.path,
                          keyframeId: entry.keyframe.id,
                          time: nextTime,
                        }
                      : {
                          type: "moveEffectParameterKeyframe",
                          layerId: layer.id,
                          effectId: entry.effectId,
                          parameter: entry.parameter,
                          keyframeId: entry.keyframe.id,
                          time: nextTime,
                        },
                  ],
                });
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
            style={{ left: entry.keyframe.time * pixelsPerSecond }}
            title={`${entry.label} · ${entry.keyframe.time.toFixed(2)}s · ${entry.keyframe.value.toFixed(2)} · drag to retime · right-click to delete`}
            type="button"
          >
            <span />
          </button>
        ))}
      </div>
      {expanded && (
        <div className="expanded-properties">
          <div>
            <KeyRound size={11} />
            <span>Transform</span>
            <small>
              {keyframes.filter((entry) => entry.source === "transform").length} keyframes
            </small>
          </div>
          {effectTracks.map((track) => (
            <div key={`${track.effectId}:${track.parameter}`}>
              <Sparkles size={11} />
              <span>{track.label}</span>
              <small>{track.count} keyframes</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GraphEditor() {
  const { state, dispatch } = useEditor();
  const composition = activeComposition(state.project);
  const layer = composition.layers.find((entry) => entry.id === state.selection[0]);
  const property = layer?.transform.position[1];
  const keyframes = property?.mode === "animated" ? property.keyframes : [];
  const width = 1000;
  const height = 260;
  const values = keyframes.map((keyframe) => keyframe.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const points = keyframes
    .map(
      (keyframe) =>
        `${(keyframe.time / composition.duration) * width},${height - ((keyframe.value - min) / (max - min || 1)) * (height - 60) - 30}`,
    )
    .join(" ");
  return (
    <div className="graph-editor">
      <div className="graph-sidebar">
        <strong>{layer?.name ?? "No selection"}</strong>
        <button
          className="active"
          onClick={() => {
            if (keyframes[0]) dispatch({ type: "setTime", time: keyframes[0].time });
          }}
          title="Focus Y Position curve"
          type="button"
        >
          <span className="property-color" /> Y Position
        </button>
        <small>Value graph</small>
      </div>
      <svg
        aria-label="Keyframe value graph"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <pattern height="26" id="grid" patternUnits="userSpaceOnUse" width="50">
            <path
              d="M 50 0 L 0 0 0 26"
              fill="none"
              stroke="rgba(255,255,255,.055)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect fill="url(#grid)" height={height} width={width} />
        {points && (
          <polyline
            fill="none"
            points={points}
            stroke="#68a0ff"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {keyframes.map((keyframe) => {
          const x = (keyframe.time / composition.duration) * width;
          const y = height - ((keyframe.value - min) / (max - min || 1)) * (height - 60) - 30;
          return (
            <g key={keyframe.id}>
              <line stroke="#775cff" strokeWidth="1" x1={x - 50} x2={x} y1={y + 18} y2={y} />
              <circle cx={x} cy={y} fill="#d7e5ff" r="5" stroke="#477ef5" strokeWidth="2" />
            </g>
          );
        })}
        <line
          stroke="#ff5b6e"
          strokeWidth="1.5"
          x1={(state.currentTime / composition.duration) * width}
          x2={(state.currentTime / composition.duration) * width}
          y1="0"
          y2={height}
        />
      </svg>
    </div>
  );
}

function usePlayback(duration: number) {
  const { state, dispatch } = useEditor();
  const currentTime = useRef(state.currentTime);
  currentTime.current = state.currentTime;
  useEffect(() => {
    if (!state.playing) return;
    const startedAt = performance.now();
    const initialTime = currentTime.current;
    let frame = 0;
    const tick = (now: number) => {
      dispatch({ type: "setTime", time: (initialTime + (now - startedAt) / 1000) % duration });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dispatch, duration, state.playing]);
}

function collectKeyframes(layer: Layer): TimelineKeyframeEntry[] {
  const properties: Array<[PropertyPath, Animatable]> = [
    ["position.0", layer.transform.position[0]],
    ["position.1", layer.transform.position[1]],
    ["position.2", layer.transform.position[2]],
    ["rotation.0", layer.transform.rotation[0]],
    ["rotation.1", layer.transform.rotation[1]],
    ["rotation.2", layer.transform.rotation[2]],
    ["scale.0", layer.transform.scale[0]],
    ["scale.1", layer.transform.scale[1]],
    ["scale.2", layer.transform.scale[2]],
    ["opacity", layer.transform.opacity],
  ];
  const transformKeyframes: TimelineKeyframeEntry[] = properties.flatMap(([path, property]) =>
    property.mode === "animated"
      ? property.keyframes.map((keyframe) => ({
          source: "transform" as const,
          keyframe,
          path,
          label: path,
        }))
      : [],
  );
  const effectKeyframes: TimelineKeyframeEntry[] = layer.effects.flatMap((effect) =>
    Object.entries(effect.parameterKeyframes ?? {}).flatMap(([parameter, keyframes]) =>
      keyframes.map((keyframe) => ({
        source: "effect" as const,
        keyframe,
        effectId: effect.id,
        parameter,
        label: `${effect.name} · ${parameter}`,
      })),
    ),
  );
  return [...transformKeyframes, ...effectKeyframes];
}

function collectEffectTracks(layer: Layer) {
  return layer.effects.flatMap((effect) =>
    Object.entries(effect.parameterKeyframes ?? {}).map(([parameter, keyframes]) => ({
      effectId: effect.id,
      parameter,
      label: `${effect.name} · ${parameter}`,
      count: keyframes.length,
    })),
  );
}

function formatTimecode(
  time: number,
  frameRate: { numerator: number; denominator: number },
): string {
  const totalFrames = frameAt(time, frameRate);
  const fps = Math.round(frameRate.numerator / frameRate.denominator);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frames]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

const formatSeconds = (time: number) =>
  `${Math.floor(time / 60)}:${Math.floor(time % 60)
    .toString()
    .padStart(2, "0")}`;

function toggleTimelineFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else {
    const panel = document.querySelector<HTMLElement>(".timeline-panel");
    if (panel) void panel.requestFullscreen();
  }
}
