import { ChevronDown, ChevronRight, Move3d, Sparkles, Timer } from "lucide-react";
import { useState } from "react";
import { propertyValueOperationAtTime } from "../core/property-edit-operation";
import { createId, type Keyframe, type Layer } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { TimelineKeyframe, type TimelineKeyframeEntry } from "./TimelineKeyframe";
import type { buildTimelineSnapTargets } from "./timeline-interactions";
import {
  collectTimelinePropertyGroups,
  evaluateTimelinePropertyTrack,
  type KeyframeTimePreview,
  type TimelinePropertyTrack,
  timelinePropertyTrackLabel,
  timelineTrackKeyframes,
} from "./timeline-property-tracks";
import type { StartWindowPointerDrag } from "./use-window-pointer-drag";

const KEYFRAME_TIME_EPSILON = 0.000_001;

export function TimelinePropertyRows({
  compositionDuration,
  frameDuration,
  keyframeTimePreview,
  layer,
  onKeyframeTimePreview,
  pixelsPerSecond,
  startPointerDrag,
  timelineTargets,
}: {
  compositionDuration: number;
  frameDuration: number;
  keyframeTimePreview?: KeyframeTimePreview;
  layer: Layer;
  onKeyframeTimePreview: (preview?: KeyframeTimePreview) => void;
  pixelsPerSecond: number;
  startPointerDrag: StartWindowPointerDrag;
  timelineTargets: ReturnType<typeof buildTimelineSnapTargets>;
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const groups = collectTimelinePropertyGroups(layer);
  const updateValue = (track: TimelinePropertyTrack, value: number) => {
    if (layer.locked || !Number.isFinite(value)) return;
    if (track.source === "effect") {
      dispatch({
        type: "operation",
        operations: [
          {
            type: "setEffectParameterAtTime",
            layerId: layer.id,
            effectId: track.effectId,
            parameter: track.parameter,
            time: state.currentTime,
            value,
            keyframeId: keyframeAtTime(track, state.currentTime)?.id ?? createId(),
          },
        ],
      });
      return;
    }
    const current = keyframeAtTime(track, state.currentTime);
    dispatch({
      type: "operation",
      operations: [
        propertyValueOperationAtTime(layer, track.path, value, state.currentTime, current?.id),
      ],
    });
  };
  const toggleKeyframe = (track: TimelinePropertyTrack) => {
    if (layer.locked) return;
    const current = keyframeAtTime(track, state.currentTime);
    if (current) {
      dispatch({
        type: "operation",
        operations: [
          track.source === "transform"
            ? {
                type: "removeKeyframe",
                layerId: layer.id,
                path: track.path,
                keyframeId: current.id,
              }
            : {
                type: "removeEffectParameterKeyframe",
                layerId: layer.id,
                effectId: track.effectId,
                parameter: track.parameter,
                keyframeId: current.id,
              },
        ],
      });
      return;
    }
    const value = evaluateTimelinePropertyTrack(track, state.currentTime);
    const keyframe = createTimelineKeyframe(state.currentTime, value);
    dispatch({
      type: "operation",
      operations: [
        track.source === "transform"
          ? {
              type: "addKeyframe",
              layerId: layer.id,
              path: track.path,
              keyframe,
            }
          : {
              type: "addEffectParameterKeyframe",
              layerId: layer.id,
              effectId: track.effectId,
              parameter: track.parameter,
              keyframe,
            },
      ],
    });
    dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
  };
  return (
    <div className="expanded-properties">
      {groups.map((group) => {
        const groupKeyframes = group.tracks.flatMap((track) => {
          const label = timelinePropertyTrackLabel(track, t);
          return timelineTrackKeyframes(track).map((keyframe) => ({
            entry: keyframeEntry(layer.id, track, keyframe, label),
            trackId: track.id,
          }));
        });
        const keyframeCount = groupKeyframes.length;
        const expanded = !collapsedGroups.has(group.id);
        const groupLabel = group.labelKey ? t(group.labelKey) : group.label;
        return (
          <div className="timeline-property-group" key={group.id}>
            <button
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? t("timeline.propertyGroup.collapse", { name: groupLabel })
                  : t("timeline.propertyGroup.expand", { name: groupLabel })
              }
              className={`timeline-property-group-label ${group.source}`}
              onClick={() =>
                setCollapsedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                })
              }
              type="button"
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {group.source === "transform" ? <Move3d size={11} /> : <Sparkles size={11} />}
              <span>{groupLabel}</span>
              <small>
                {t(keyframeCount === 1 ? "timeline.layer.keyframe" : "timeline.layer.keyframes", {
                  count: keyframeCount,
                })}
              </small>
            </button>
            <div className="timeline-property-group-track">
              {groupKeyframes.map(({ entry, trackId }) => (
                <TimelineKeyframe
                  compositionDuration={compositionDuration}
                  disabled={layer.locked}
                  entry={entry}
                  frameDuration={frameDuration}
                  key={`${trackId}:${entry.keyframe.id}`}
                  onPreview={onKeyframeTimePreview}
                  pixelsPerSecond={pixelsPerSecond}
                  preview={keyframeTimePreview}
                  startPointerDrag={startPointerDrag}
                  timelineTargets={timelineTargets}
                  variant="property"
                />
              ))}
            </div>
            {expanded &&
              group.tracks.map((track) => {
                const keyframes = timelineTrackKeyframes(track);
                const current = keyframeAtTime(track, state.currentTime);
                const label = timelinePropertyTrackLabel(track, t);
                const value = evaluateTimelinePropertyTrack(
                  track,
                  state.currentTime,
                  keyframeTimePreview,
                );
                return (
                  <div className="timeline-property-row" key={track.id}>
                    <div className="timeline-property-label">
                      <button
                        aria-label={
                          current
                            ? t("timeline.property.removeKeyframe", { label })
                            : t("timeline.property.addKeyframe", { label })
                        }
                        className={`timeline-property-key ${keyframes.length ? "animated" : ""} ${current ? "active" : ""}`}
                        disabled={layer.locked}
                        onClick={() => toggleKeyframe(track)}
                        title={
                          current
                            ? t("timeline.property.removeKeyframe", { label })
                            : t("timeline.property.addKeyframe", { label })
                        }
                        type="button"
                      >
                        <Timer size={10} />
                      </button>
                      <span className="timeline-property-name" title={label}>
                        {label}
                      </span>
                      <TimelinePropertyValue
                        disabled={layer.locked}
                        label={label}
                        onChange={(next) => updateValue(track, next)}
                        track={track}
                        value={value}
                      />
                    </div>
                    <div className="timeline-property-track">
                      {keyframes.map((keyframe) => (
                        <TimelineKeyframe
                          compositionDuration={compositionDuration}
                          disabled={layer.locked}
                          entry={keyframeEntry(layer.id, track, keyframe, label)}
                          frameDuration={frameDuration}
                          key={keyframe.id}
                          onPreview={onKeyframeTimePreview}
                          pixelsPerSecond={pixelsPerSecond}
                          preview={keyframeTimePreview}
                          startPointerDrag={startPointerDrag}
                          timelineTargets={timelineTargets}
                          variant="property"
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function TimelinePropertyValue({
  disabled,
  label,
  onChange,
  track,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: number) => void;
  track: TimelinePropertyTrack;
  value: number;
}) {
  const { t } = useI18n();
  const ariaLabel = t("timeline.property.edit", { label });
  if (track.source === "effect" && track.definition.kind === "toggle") {
    return (
      <input
        aria-label={ariaLabel}
        checked={value > 0.5}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked ? 1 : 0)}
        type="checkbox"
      />
    );
  }
  if (track.source === "effect" && track.definition.kind === "choice") {
    return (
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        value={Math.round(value)}
      >
        {track.definition.options?.map((option, index) => (
          <option key={option} value={index}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (track.source === "effect" && track.definition.kind === "color") {
    return (
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => onChange(Number.parseInt(event.target.value.slice(1), 16))}
        type="color"
        value={`#${Math.max(0, Math.min(0xffffff, Math.round(value)))
          .toString(16)
          .padStart(6, "0")}`}
      />
    );
  }
  const minimum = track.source === "effect" ? track.definition.min : track.min;
  const maximum = track.source === "effect" ? track.definition.max : track.max;
  const step = track.source === "effect" ? track.definition.step : track.step;
  const unit = track.source === "effect" ? track.definition.unit : track.unit;
  return (
    <span className="timeline-property-number">
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        max={maximum}
        min={minimum}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={formatTimelineValue(value)}
      />
      <small>{unit}</small>
    </span>
  );
}

function keyframeAtTime(track: TimelinePropertyTrack, time: number): Keyframe | undefined {
  return timelineTrackKeyframes(track).find(
    (keyframe) => Math.abs(keyframe.time - time) <= KEYFRAME_TIME_EPSILON,
  );
}

function createTimelineKeyframe(time: number, value: number, id = createId()): Keyframe {
  return {
    id,
    time,
    value,
    interpolation: "bezier",
    easing: [0.42, 0, 0.58, 1],
  };
}

function keyframeEntry(
  layerId: string,
  track: TimelinePropertyTrack,
  keyframe: Keyframe,
  label: string,
): TimelineKeyframeEntry {
  return track.source === "transform"
    ? { source: "transform", layerId, path: track.path, keyframe, label }
    : {
        source: "effect",
        layerId,
        effectId: track.effectId,
        parameter: track.parameter,
        keyframe,
        label,
      };
}

function formatTimelineValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}
