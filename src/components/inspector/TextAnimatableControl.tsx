import { Timer } from "lucide-react";
import { evaluateAnimatable, insertKeyframe } from "../../core/animation/timeline";
import { type Animatable, createId, staticValue } from "../../core/types";
import { valuesDiffer } from "./inspector-selection";
import { MixedValueInput } from "./MixedValueInput";
import { type SettingsEdit, settingsEdit } from "./settings-edit";

const KEYFRAME_EPSILON = 0.000_001;

export function TextAnimatableControl({
  keyframeLabel,
  label,
  max,
  min,
  onChange,
  property,
  selection = [property],
  times,
  step = 1,
  time,
}: {
  keyframeLabel: string;
  label: string;
  max?: number;
  min?: number;
  onChange: SettingsEdit<Animatable>;
  selection?: readonly Animatable[];
  times?: readonly number[];
  property: Animatable;
  step?: number;
  time: number;
}) {
  const value = evaluateAnimatable(property, time);
  const edit = settingsEdit(property, onChange, selection.length);
  const timeAt = (index: number) => times?.[index] ?? time;
  const keyframeAt = (track: Animatable, index: number) =>
    track.mode === "animated"
      ? track.keyframes.find(
          (keyframe) => Math.abs(keyframe.time - timeAt(index)) <= KEYFRAME_EPSILON,
        )
      : undefined;
  const keyframed = selection.every((track, index) => keyframeAt(track, index));
  const updateValue = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    edit((track, index) => {
      const current = keyframeAt(track, index);
      return track.mode === "animated"
        ? insertKeyframe(track, {
            ...current,
            id: current?.id ?? createId(),
            time: Math.max(0, timeAt(index)),
            value: nextValue,
            interpolation: current?.interpolation ?? "linear",
          })
        : staticValue(nextValue);
    });
  };
  const toggleKeyframe = () =>
    edit((track, index) => {
      const current = keyframeAt(track, index);
      const currentValue = evaluateAnimatable(track, timeAt(index));
      if (!keyframed)
        return insertKeyframe(track, {
          ...current,
          id: current?.id ?? createId(),
          time: Math.max(0, timeAt(index)),
          value: currentValue,
          interpolation: current?.interpolation ?? "linear",
        });
      if (track.mode !== "animated") return track;
      const keyframes = track.keyframes.filter((keyframe) => keyframe !== current);
      return keyframes.length ? { ...track, keyframes } : staticValue(currentValue);
    });
  return (
    <label className="text-animatable-control">
      <span>{label}</span>
      <MixedValueInput
        mixed={valuesDiffer(
          selection.map((track, index) => evaluateAnimatable(track, timeAt(index))),
        )}
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => updateValue(Number(event.target.value))}
        step={step}
        type="number"
        value={Number.isFinite(value) ? value : 0}
      />
      <button
        aria-label={keyframeLabel}
        aria-pressed={keyframed}
        className={keyframed ? "active" : ""}
        onClick={toggleKeyframe}
        type="button"
      >
        <Timer aria-hidden="true" size={10} />
      </button>
    </label>
  );
}
