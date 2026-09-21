import { evaluateAnimatable } from "../../core/animation/timeline";
import type { PropertyPath } from "../../core/editing/operations";
import type { PluginParameter } from "../../core/plugins/plugins";
import type { CameraSettings, SceneGeneratorParameterValue } from "../../core/types";
import { valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";
import type { SettingsEdit } from "./settings-edit";

export function GeneratorParameterControl({
  selection,
  onChange,
  parameter,
  value,
}: {
  onChange: SettingsEdit<SceneGeneratorParameterValue>;
  selection: readonly (SceneGeneratorParameterValue | undefined)[];
  parameter: PluginParameter;
  value: SceneGeneratorParameterValue | undefined;
}) {
  switch (parameter.type) {
    case "number":
      return (
        <NumericControl
          label={parameter.label}
          max={parameter.max}
          min={parameter.min}
          onChange={onChange}
          step={Math.max((parameter.max - parameter.min) / 100, 0.001)}
          mixed={valuesDiffer(
            selection.map((entry) => (typeof entry === "number" ? entry : parameter.default)),
          )}
          value={typeof value === "number" ? value : parameter.default}
        />
      );
    case "choice":
      return (
        <label>
          {parameter.label}
          <MixedValueSelect
            aria-label={parameter.label}
            onChange={(event) => onChange(event.target.value)}
            mixed={valuesDiffer(
              selection.map((entry) => (typeof entry === "string" ? entry : parameter.default)),
            )}
            value={typeof value === "string" ? value : parameter.default}
          >
            {parameter.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </MixedValueSelect>
        </label>
      );
    case "color":
    case "vector": {
      const fallback = parameter.default;
      const channels = Array.isArray(value) ? value : fallback;
      const channelNames = ["x", "y", "z", "w"].slice(0, channels.length);
      const minimum = parameter.type === "vector" ? parameter.min : 0;
      const maximum = parameter.type === "vector" ? parameter.max : 1;
      return (
        <fieldset className="scene-generator-vector">
          <legend>{parameter.label}</legend>
          {channelNames.map((channelName, index) => (
            <MixedValueInput
              aria-label={`${parameter.label} ${index + 1}`}
              key={`${parameter.name}-${channelName}`}
              max={maximum}
              min={minimum}
              onChange={(event) => {
                const update = (current: SceneGeneratorParameterValue) => {
                  const next = [...(Array.isArray(current) ? current : fallback)];
                  next[index] = Number(event.target.value);
                  return next;
                };
                onChange(update(channels), update);
              }}
              step={Math.max((maximum - minimum) / 100, 0.001)}
              type="number"
              mixed={valuesDiffer(
                selection.map((entry) => (Array.isArray(entry) ? entry : fallback)[index]),
              )}
              value={channels[index]}
            />
          ))}
        </fieldset>
      );
    }
    case "texture":
      return (
        <label>
          {parameter.label}
          <MixedValueInput disabled type="text" value="Host texture input" />
        </label>
      );
  }
}

export function NumericControl({
  mixed,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
  mixed?: boolean;
}) {
  return (
    <label>
      {label}
      <MixedValueInput
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        mixed={mixed}
        value={value}
      />
    </label>
  );
}

export function BooleanControl({
  mixed,
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label>
      <MixedValueInput
        mixed={mixed}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}

export function CameraVectorControl({
  selections,
  label,
  onChange,
  paths,
  properties,
  time,
  unit,
}: {
  label: string;
  onChange: (path: PropertyPath, value: number) => void;
  paths: readonly [PropertyPath, PropertyPath, PropertyPath];
  properties: CameraSettings["pointOfInterest"];
  selections: readonly CameraSettings["pointOfInterest"][];
  time: number;
  unit: string;
}) {
  return (
    <fieldset className="scene-generator-vector">
      <legend>{label}</legend>
      {properties.map((property, index) => (
        <label key={paths[index]}>
          {"XYZ"[index]}
          <MixedValueInput
            aria-label={`${label} ${"XYZ"[index]}`}
            onChange={(event) => onChange(paths[index], Number(event.target.value))}
            step={0.1}
            type="number"
            mixed={valuesDiffer(selections.map((entry) => evaluateAnimatable(entry[index], time)))}
            value={evaluateAnimatable(property, time)}
          />
          <span>{unit}</span>
        </label>
      ))}
    </fieldset>
  );
}
