import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Eye,
  EyeOff,
  Film,
  Gauge,
  GripVertical,
  Headphones,
  Layers3,
  Lock,
  LockOpen,
  Music2,
  Square,
  Type,
  Volume2,
  VolumeX,
  Wind,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useState,
} from "react";
import { layerSupportsMotionBlur } from "../../core/animation/motion-blur";
import { canToggleLayer, type LayerToggleField } from "../../core/editing/operations";
import type { activeComposition } from "../../core/project/project";
import type { Keyframe, Layer } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditorDocument } from "../../state/editor-store";
import type { StartWindowPointerDrag } from "../use-window-pointer-drag";
import { AudioWaveform } from "./AudioWaveform";
import { LayerTimingBar } from "./LayerTimingBar";
import { TimelineKeyframe, type TimelineKeyframeEntry } from "./TimelineKeyframe";
import { TimelinePropertyRows } from "./TimelinePropertyRows";
import {
  compositionFrameDuration,
  type LayerTimingDrag,
  type TimelineSnapTargets,
} from "./timeline-interactions";
import {
  collectTimelinePropertyGroups,
  type KeyframeTimePreview,
  type TimelinePropertyTrack,
  timelineTrackKeyframes,
} from "./timeline-property-tracks";

const LABEL_WIDTH = 286;

export function TimelineLayerRow({
  composition,
  index,
  keyframeTimePreview,
  layer,
  onDragStart,
  onDragEnd,
  onDrop,
  onKeyframeTimePreview,
  onContextMenu,
  onContextMenuKeyDown,
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
  keyframeTimePreview?: KeyframeTimePreview;
  layer: Layer;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onKeyframeTimePreview: (preview?: KeyframeTimePreview) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenuKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onMarqueeStart: (event: ReactPointerEvent) => void;
  onTimingDragStart: (event: ReactPointerEvent, mode: LayerTimingDrag) => void;
  pixelsPerSecond: number;
  selected: boolean;
  startPointerDrag: StartWindowPointerDrag;
  timelineTargets: TimelineSnapTargets;
  timing?: { inPoint: number; outPoint: number };
}) {
  const { state, dispatch } = useEditorDocument();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(selected && layer.name === "ASTER");
  const frameDuration = compositionFrameDuration(composition);
  const keyframes = collectTimelineLayerKeyframes(layer);
  const Icon = layerIcon(layer);
  const audioSource = state.project.sources.find((source) => source.id === layer.sourceId);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Native drag-and-drop requires row-level handlers.
    <div
      className={`timeline-layer ${selected ? "selected" : ""}`}
      data-timeline-row={index}
      onContextMenu={(event) => {
        event.currentTarget
          .querySelector<HTMLElement>(".layer-label")
          ?.focus({ preventScroll: true });
        onContextMenu(event);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: This control contains independent layer-switch buttons. */}
      <div
        className="layer-label"
        draggable={!layer.locked}
        onClick={(event) => {
          const ids = event.shiftKey
            ? state.selection.includes(layer.id)
              ? state.selection.filter((id) => id !== layer.id)
              : [...state.selection, layer.id]
            : [layer.id];
          dispatch({ type: "select", ids });
        }}
        onKeyDown={(event) => {
          onContextMenuKeyDown(event);
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
        {audioSource && (layer.kind === "audio" || layer.kind === "video") && (
          <AudioWaveform layer={layer} pixelsPerSecond={pixelsPerSecond} source={audioSource} />
        )}
        {keyframes.map((entry) => (
          <TimelineKeyframe
            compositionDuration={composition.duration}
            disabled={layer.locked}
            entry={entry}
            frameDuration={frameDuration}
            key={`${entry.source}:${entry.keyframe.id}`}
            onPreview={onKeyframeTimePreview}
            pixelsPerSecond={pixelsPerSecond}
            preview={keyframeTimePreview}
            startPointerDrag={startPointerDrag}
            timelineTargets={timelineTargets}
          />
        ))}
      </div>
      {expanded && (
        <TimelinePropertyRows
          compositionDuration={composition.duration}
          frameDuration={frameDuration}
          keyframeTimePreview={keyframeTimePreview}
          layer={layer}
          onKeyframeTimePreview={onKeyframeTimePreview}
          pixelsPerSecond={pixelsPerSecond}
          startPointerDrag={startPointerDrag}
          timelineTargets={timelineTargets}
        />
      )}
    </div>
  );
}

function LayerSwitches({ layer }: { layer: Layer }) {
  const { dispatch } = useEditorDocument();
  const { t } = useI18n();
  const toggle = (field: LayerToggleField) => {
    if (!canToggleLayer(layer, field)) return;
    dispatch({
      type: "operation",
      operations: [{ type: "toggleLayer", layerId: layer.id, field }],
    });
  };
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
        disabled={layer.kind === "audio"}
        type="button"
      >
        {layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
      </button>
      <button
        aria-label={
          layer.solo
            ? t("timeline.layer.disableSolo", { name: layer.name })
            : t("timeline.layer.enableSolo", { name: layer.name })
        }
        className={layer.solo ? "enabled" : ""}
        onClick={(event) => {
          event.stopPropagation();
          toggle("solo");
        }}
        type="button"
      >
        <Headphones size={11} />
      </button>
      <button
        aria-label={
          layer.kind === "video" || layer.kind === "audio"
            ? t("timeline.layer.toggleAudio", { name: layer.name })
            : t("timeline.layer.noAudio", { name: layer.name })
        }
        disabled={layer.locked || (layer.kind !== "video" && layer.kind !== "audio")}
        onClick={(event) => {
          event.stopPropagation();
          toggle("audioEnabled");
        }}
        title={
          layer.kind === "video" || layer.kind === "audio"
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
          layer.kind === "adjustment" || layer.kind === "audio"
            ? t("timeline.layer.adjustmentNo3d")
            : layer.threeDimensional
              ? t("timeline.layer.disable3d", { name: layer.name })
              : t("timeline.layer.enable3d", { name: layer.name })
        }
        className={layer.threeDimensional ? "enabled" : ""}
        disabled={layer.locked || layer.kind === "adjustment" || layer.kind === "audio"}
        onClick={(event) => {
          event.stopPropagation();
          toggle("threeDimensional");
        }}
        type="button"
      >
        <Box size={11} />
      </button>
      <button
        aria-label={
          layer.motionBlur
            ? t("timeline.layer.disableMotionBlur", { name: layer.name })
            : t("timeline.layer.enableMotionBlur", { name: layer.name })
        }
        className={layer.motionBlur ? "enabled" : ""}
        disabled={layer.locked || !layerSupportsMotionBlur(layer)}
        onClick={(event) => {
          event.stopPropagation();
          toggle("motionBlur");
        }}
        title={
          layerSupportsMotionBlur(layer)
            ? t("timeline.menu.motionBlur")
            : t("timeline.menu.motionBlurUnavailable")
        }
        type="button"
      >
        <Wind size={11} />
      </button>
    </div>
  );
}

export function collectTimelineLayerKeyframes(layer: Layer): TimelineKeyframeEntry[] {
  return collectTimelinePropertyGroups(layer).flatMap((group) =>
    group.tracks.flatMap((track) =>
      timelineTrackKeyframes(track).map((keyframe) =>
        timelineKeyframeEntry(layer.id, track, keyframe),
      ),
    ),
  );
}

function timelineKeyframeEntry(
  layerId: string,
  track: TimelinePropertyTrack,
  keyframe: Keyframe,
): TimelineKeyframeEntry {
  return track.source === "transform"
    ? {
        source: "transform",
        layerId,
        path: track.path,
        keyframe,
        label: track.path,
      }
    : {
        source: "effect",
        layerId,
        effectId: track.effectId,
        parameter: track.parameter,
        keyframe,
        label: `${track.effectName} · ${track.definition.label}`,
      };
}

function layerIcon(layer: Layer) {
  if (layer.kind === "null") return CircleDashed;
  if (layer.kind === "solid") return Square;
  if (layer.kind === "text") return Type;
  if (layer.kind === "video") return Film;
  if (layer.kind === "audio") return Music2;
  if (layer.kind === "camera") return Layers3;
  if (layer.kind === "generator") return Gauge;
  return Box;
}
