import { Timer } from "lucide-react";
import { evaluateAnimatable, insertKeyframe } from "../../core/animation/timeline";
import { type Animatable, createId, staticValue } from "../../core/types";

const KEYFRAME_EPSILON = 0.000_001;

export function TextAnimatableControl({
  keyframeLabel,
  label,
  max,
  min,
  onChange,
  property,
  step = 1,
  time,
}: {
  keyframeLabel: string;
  label: string;
  max?: number;
  min?: number;
  onChange: (property: Animatable) => void;
  property: Animatable;
  step?: number;
  time: number;
}) {
  const value = evaluateAnimatable(property, time);
  const keyframeIndex =
    property.mode === "animated"
      ? property.keyframes.findIndex(
          (keyframe) => Math.abs(keyframe.time - time) <= KEYFRAME_EPSILON,
        )
      : -1;
  const updateValue = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    onChange(
      property.mode === "animated"
        ? insertKeyframe(property, {
            id:
              keyframeIndex >= 0
                ? (property.keyframes[keyframeIndex]?.id ?? createId())
                : createId(),
            time: Math.max(0, time),
            value: nextValue,
            interpolation: property.keyframes[keyframeIndex]?.interpolation ?? "linear",
            easing: property.keyframes[keyframeIndex]?.easing,
          })
        : staticValue(nextValue),
    );
  };
  const toggleKeyframe = () => {
    if (property.mode === "static" || keyframeIndex < 0) {
      onChange(
        insertKeyframe(property, {
          id: createId(),
          time: Math.max(0, time),
          value,
          interpolation: "linear",
        }),
      );
      return;
    }
    const keyframes = property.keyframes.filter((_, index) => index !== keyframeIndex);
    onChange(keyframes.length ? { mode: "animated", keyframes } : staticValue(value));
  };
  return (
    <label className="text-animatable-control">
      <span>{label}</span>
      <input
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
        aria-pressed={keyframeIndex >= 0}
        className={keyframeIndex >= 0 ? "active" : ""}
        onClick={toggleKeyframe}
        type="button"
      >
        <Timer aria-hidden="true" size={10} />
      </button>
    </label>
  );
}
