import { KeyRound } from "lucide-react";
import type { EffectParameterDefinition } from "../effects/types";

export function EffectParameter({
  definition,
  value,
  onChange,
  onToggleKeyframe,
  animated,
  keyframed,
}: {
  definition: EffectParameterDefinition;
  value: number;
  onChange: (value: number) => void;
  onToggleKeyframe: (value: number) => void;
  animated: boolean;
  keyframed: boolean;
}) {
  if (definition.kind === "texture") {
    return (
      <div className="effect-parameter">
        <span>{definition.label}</span>
        <small title="WGSL effect ABI v1 binds the current layer as the source texture">
          Layer source
        </small>
      </div>
    );
  }
  if (definition.kind === "toggle") {
    return (
      <label className="effect-parameter effect-toggle">
        <span>{definition.label}</span>
        <input
          checked={value > 0.5}
          onChange={(event) => onChange(event.target.checked ? 1 : 0)}
          type="checkbox"
        />
        <EffectKeyframeButton
          animated={animated}
          keyframed={keyframed}
          label={definition.label}
          onClick={() => onToggleKeyframe(value)}
        />
      </label>
    );
  }
  if (definition.kind === "choice") {
    return (
      <label className="effect-parameter">
        <span>{definition.label}</span>
        <select onChange={(event) => onChange(Number(event.target.value))} value={value}>
          {definition.options?.map((option, index) => (
            <option key={option} value={index}>
              {option}
            </option>
          ))}
        </select>
        <EffectKeyframeButton
          animated={animated}
          keyframed={keyframed}
          label={definition.label}
          onClick={() => onToggleKeyframe(value)}
        />
      </label>
    );
  }
  if (definition.kind === "color") {
    return (
      <label className="effect-parameter effect-color">
        <span>{definition.label}</span>
        <input
          onChange={(event) => onChange(Number.parseInt(event.target.value.slice(1), 16))}
          type="color"
          value={`#${Math.max(0, Math.min(0xffffff, Math.round(value)))
            .toString(16)
            .padStart(6, "0")}`}
        />
        <EffectKeyframeButton
          animated={animated}
          keyframed={keyframed}
          label={definition.label}
          onClick={() => onToggleKeyframe(value)}
        />
      </label>
    );
  }
  return (
    <label className="effect-parameter effect-numeric">
      <span>{definition.label}</span>
      <input
        className="effect-range"
        max={definition.max}
        min={definition.min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={definition.step}
        type="range"
        value={value}
      />
      <span className="effect-value">
        <input
          max={definition.max}
          min={definition.min}
          onChange={(event) => onChange(Number(event.target.value))}
          step={definition.step}
          type="number"
          value={value}
        />
        <small>{definition.unit}</small>
      </span>
      <EffectKeyframeButton
        animated={animated}
        keyframed={keyframed}
        label={definition.label}
        onClick={() => onToggleKeyframe(value)}
      />
    </label>
  );
}

function EffectKeyframeButton({
  animated,
  keyframed,
  label,
  onClick,
}: {
  animated: boolean;
  keyframed: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={`${keyframed ? "Remove" : "Add"} ${label} keyframe`}
      className={`effect-keyframe ${animated ? "animated" : ""} ${keyframed ? "active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <KeyRound size={10} />
    </button>
  );
}
