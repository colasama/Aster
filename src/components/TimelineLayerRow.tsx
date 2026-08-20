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
  Sparkles,
  Type,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useState } from "react";
import {
  selectedKeyframes as findSelectedKeyframes,
  removeKeyframes,
  retimeKeyframes,
} from "../core/keyframe-editing";
import type { PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { snapTimelineTime } from "../core/timeline-editing";
import type { Animatable, Keyframe, Layer } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { LayerTimingBar } from "./LayerTimingBar";
import {
  type buildTimelineSnapTargets,
  compositionFrameDuration,
  excludeTimelineSnapTargets,
  type LayerTimingDrag,
} from "./timeline-interactions";
import type { StartWindowPointerDrag } from "./use-window-pointer-drag";

const LABEL_WIDTH = 286;

type TimelineKeyframeEntry =
  | { source: "transform"; keyframe: Keyframe; path: PropertyPath; label: string }
  | {
      source: "effect";
      keyframe: Keyframe;
      effectId: string;
      parameter: string;
      label: string;
    };

export function TimelineLayerRow({
  composition,
  index,
  layer,
  onDragStart,
  onDragEnd,
  onDrop,
  onMarqueeStart,
  onTimingDragStart,
  pixelsPerSecond,
  selected,
  startPointerDrag,
  timelineTargets,
  timing,
}: {
  composition: ReturnType<typeof activeComposition>;
  index: number;
  layer: Layer;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onMarqueeStart: (event: ReactPointerEvent) => void;
  onTimingDragStart: (event: ReactPointerEvent, mode: LayerTimingDrag) => void;
  pixelsPerSecond: number;
  selected: boolean;
  startPointerDrag: StartWindowPointerDrag;
  timelineTargets: ReturnType<typeof buildTimelineSnapTargets>;
  timing?: { inPoint: number; outPoint: number };
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(selected && layer.name === "ASTER");
  const frameDuration = compositionFrameDuration(composition);
  const keyframes = collectTimelineLayerKeyframes(layer);
  const effectTracks = collectEffectTracks(layer);
  const Icon = layerIcon(layer);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Native drag-and-drop requires row-level handlers.
    <div
      className={`timeline-layer ${selected ? "selected" : ""}`}
      data-timeline-row={index}
      onDragOver={(event) => event.preventDefault()}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: This control contains independent layer-switch buttons. */}
      <div
        className="layer-label"
        draggable
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
        onDragStart={onDragStart}
        role="button"
        tabIndex={0}
      >
        <GripVertical className="drag-handle" size={11} />
        <button
          aria-label={
            expanded
              ? t("timeline.layer.collapse", { name: layer.name })
              : t("timeline.layer.expand", { name: layer.name })
          }
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
        {state.showLayerControls && <LayerSwitches layer={layer} />}
      </div>
      <div className="layer-track" onPointerDown={onMarqueeStart} style={{ left: LABEL_WIDTH }}>
        <LayerTimingBar
          layer={layer}
          onDragStart={onTimingDragStart}
          pixelsPerSecond={pixelsPerSecond}
          timing={timing}
        />
        {keyframes.map((entry) => (
          <TimelineKeyframe
            entry={entry}
            compositionDuration={composition.duration}
            frameDuration={frameDuration}
            key={`${entry.source}:${entry.keyframe.id}`}
            pixelsPerSecond={pixelsPerSecond}
            startPointerDrag={startPointerDrag}
            timelineTargets={timelineTargets}
          />
        ))}
      </div>
      {expanded && (
        <div className="expanded-properties">
          <div>
            <KeyRound size={11} />
            <span>{t("timeline.layer.transform")}</span>
            <small>
              {t(
                keyframes.filter((entry) => entry.source === "transform").length === 1
                  ? "timeline.layer.keyframe"
                  : "timeline.layer.keyframes",
                { count: keyframes.filter((entry) => entry.source === "transform").length },
              )}
            </small>
          </div>
          {effectTracks.map((track) => (
            <div key={`${track.effectId}:${track.parameter}`}>
              <Sparkles size={11} />
              <span>{track.label}</span>
              <small>
                {t(track.count === 1 ? "timeline.layer.keyframe" : "timeline.layer.keyframes", {
                  count: track.count,
                })}
              </small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineKeyframe({
  compositionDuration,
  entry,
  frameDuration,
  pixelsPerSecond,
  startPointerDrag,
  timelineTargets,
}: {
  compositionDuration: number;
  entry: TimelineKeyframeEntry;
  frameDuration: number;
  pixelsPerSecond: number;
  startPointerDrag: StartWindowPointerDrag;
  timelineTargets: ReturnType<typeof buildTimelineSnapTargets>;
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  return (
    <button
      className={`keyframe ${entry.source === "effect" ? "effect-key" : ""} ${state.selectedKeyframes.includes(entry.keyframe.id) ? "selected" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        const ids = state.selectedKeyframes.includes(entry.keyframe.id)
          ? state.selectedKeyframes
          : [entry.keyframe.id];
        const entries = findSelectedKeyframes(activeComposition(state.project), ids);
        dispatch({ type: "operation", operations: removeKeyframes(entries) });
        dispatch({ type: "selectKeyframes", ids: [] });
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const additive = event.shiftKey;
        const alreadySelected = state.selectedKeyframes.includes(entry.keyframe.id);
        const selectedIds = additive
          ? alreadySelected
            ? state.selectedKeyframes.filter((id) => id !== entry.keyframe.id)
            : [...state.selectedKeyframes, entry.keyframe.id]
          : alreadySelected
            ? state.selectedKeyframes
            : [entry.keyframe.id];
        dispatch({ type: "selectKeyframes", ids: selectedIds });
        const selectedEntries = findSelectedKeyframes(
          activeComposition(state.project),
          selectedIds,
        );
        const dragTargets = excludeTimelineSnapTargets(timelineTargets, selectedIds);
        const startX = event.clientX;
        const initialTime = entry.keyframe.time;
        let nextTime = initialTime;
        let snapToFrames = true;
        let dragged = false;
        startPointerDrag(event.pointerId, {
          onMove: (moveEvent) => {
            if (Math.abs(moveEvent.clientX - startX) >= 2) dragged = true;
            const requestedTime = Math.max(
              0,
              Math.min(
                compositionDuration,
                initialTime + (moveEvent.clientX - startX) / pixelsPerSecond,
              ),
            );
            snapToFrames = !(moveEvent.ctrlKey || moveEvent.metaKey);
            nextTime = snapTimelineTime(
              requestedTime,
              frameDuration,
              pixelsPerSecond,
              dragTargets,
              !snapToFrames,
            ).time;
          },
          onCommit: () => {
            if (!dragged) {
              dispatch({ type: "setTime", time: initialTime });
              return;
            }
            if (Math.abs(nextTime - initialTime) < 0.001) return;
            dispatch({
              type: "operation",
              operations: retimeKeyframes(
                selectedEntries,
                entry.keyframe.id,
                nextTime,
                frameDuration,
                event.altKey,
                false,
                compositionDuration,
              ),
            });
          },
        });
      }}
      style={{ left: entry.keyframe.time * pixelsPerSecond }}
      title={t("keyframe.dragHint", {
        label: entry.label,
        time: entry.keyframe.time.toFixed(2),
        value: entry.keyframe.value.toFixed(2),
      })}
      type="button"
    >
      <span />
    </button>
  );
}

function LayerSwitches({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  const toggle = (field: "visible" | "audioEnabled" | "locked" | "threeDimensional") =>
    dispatch({
      type: "operation",
      operations: [{ type: "toggleLayer", layerId: layer.id, field }],
    });
  return (
    <div className="layer-switches">
      <button
        aria-label={
          layer.visible
            ? t("timeline.layer.hide", { name: layer.name })
            : t("timeline.layer.show", { name: layer.name })
        }
        onClick={(event) => {
          event.stopPropagation();
          toggle("visible");
        }}
        type="button"
      >
        {layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
      </button>
      <button
        aria-label={
          layer.kind === "video"
            ? t("timeline.layer.toggleAudio", { name: layer.name })
            : t("timeline.layer.noAudio", { name: layer.name })
        }
        disabled={layer.kind !== "video"}
        onClick={(event) => {
          event.stopPropagation();
          toggle("audioEnabled");
        }}
        title={
          layer.kind === "video"
            ? t("timeline.layer.toggleAudio", { name: layer.name })
            : t("timeline.layer.noAudio", { name: layer.name })
        }
        type="button"
      >
        {layer.audioEnabled === false ? <VolumeX size={11} /> : <Volume2 size={11} />}
      </button>
      <button
        aria-label={
          layer.locked
            ? t("timeline.layer.unlock", { name: layer.name })
            : t("timeline.layer.lock", { name: layer.name })
        }
        onClick={(event) => {
          event.stopPropagation();
          toggle("locked");
        }}
        type="button"
      >
        {layer.locked ? <Lock size={11} /> : <LockOpen size={11} />}
      </button>
      <button
        aria-label={
          layer.kind === "adjustment"
            ? t("timeline.layer.adjustmentNo3d")
            : layer.threeDimensional
              ? t("timeline.layer.disable3d", { name: layer.name })
              : t("timeline.layer.enable3d", { name: layer.name })
        }
        className={layer.threeDimensional ? "enabled" : ""}
        disabled={layer.kind === "adjustment"}
        onClick={(event) => {
          event.stopPropagation();
          toggle("threeDimensional");
        }}
        type="button"
      >
        <Box size={11} />
      </button>
    </div>
  );
}

export function collectTimelineLayerKeyframes(layer: Layer): TimelineKeyframeEntry[] {
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

function layerIcon(layer: Layer) {
  if (layer.kind === "text") return Type;
  if (layer.kind === "video") return Film;
  if (layer.kind === "camera") return Layers3;
  if (layer.kind === "particle") return Gauge;
  return Box;
}
