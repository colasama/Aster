import type { EffectMask } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";

export function EffectMaskEditor({
  mask,
  masks = [mask],
  onChange,
}: {
  mask: EffectMask;
  masks?: readonly EffectMask[];
  onChange: (recipe: (mask: EffectMask) => EffectMask) => void;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<EffectMask>) => onChange((current) => ({ ...current, ...patch }));
  const updatePair = (key: "center" | "size", index: 0 | 1, value: number) => {
    if (!Number.isFinite(value)) return;
    onChange((current) => {
      const pair: [number, number] = [...current[key]];
      pair[index] = value;
      return { ...current, [key]: pair };
    });
  };
  return (
    <div className="effect-mask-editor">
      <div className="effect-mask-heading">
        <strong>{t("mask.title")}</strong>
        <MixedValueSelect
          aria-label={t("mask.shape")}
          onChange={(event) => update({ shape: event.target.value as EffectMask["shape"] })}
          mixed={valuesDiffer(masks.map((entry) => entry.shape))}
          value={mask.shape}
        >
          <option value="ellipse">{t("mask.ellipse")}</option>
          <option value="rectangle">{t("mask.rectangle")}</option>
        </MixedValueSelect>
        <label>
          <MixedValueInput
            mixed={valuesDiffer(masks.map((entry) => entry.invert))}
            checked={mask.invert}
            onChange={(event) => update({ invert: event.target.checked })}
            type="checkbox"
          />
          {t("mask.invert")}
        </label>
      </div>
      <MaskPair
        label={t("mask.center")}
        max={1000}
        min={-1000}
        onChange={(index, value) => updatePair("center", index, value)}
        values={masks.map((entry) => entry.center)}
        value={mask.center}
      />
      <MaskPair
        label={t("mask.size")}
        max={2000}
        min={0.1}
        onChange={(index, value) => updatePair("size", index, value)}
        values={masks.map((entry) => entry.size)}
        value={mask.size}
      />
      <MaskScalar
        label={t("mask.feather")}
        max={500}
        min={0}
        onChange={(feather) => update({ feather })}
        step={1}
        suffix="px"
        mixed={valuesDiffer(masks.map((entry) => entry.feather))}
        value={mask.feather}
      />
      <MaskScalar
        label={t("mask.opacity")}
        max={100}
        min={0}
        onChange={(opacity) => update({ opacity })}
        step={1}
        suffix="%"
        mixed={valuesDiffer(masks.map((entry) => entry.opacity))}
        value={mask.opacity}
      />
    </div>
  );
}

function MaskPair({
  values,
  label,
  max,
  min,
  onChange,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (index: 0 | 1, value: number) => void;
  value: [number, number];
  values: readonly [number, number][];
}) {
  return (
    <div className="effect-mask-pair">
      <span>{label}</span>
      {(["X", "Y"] as const).map((axis, index) => (
        <label key={axis}>
          {axis}
          <MixedValueInput
            max={max}
            min={min}
            onChange={(event) => onChange(index as 0 | 1, Number(event.target.value))}
            step="0.1"
            type="number"
            mixed={valuesDiffer(values.map((entry) => entry[index]))}
            value={value[index]}
          />
          <small>%</small>
        </label>
      ))}
    </div>
  );
}

function MaskScalar({
  mixed,
  label,
  max,
  min,
  onChange,
  step,
  suffix,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  suffix: string;
  value: number;
  mixed: boolean;
}) {
  return (
    <label className="effect-mask-scalar">
      <span>{label}</span>
      <MixedValueInput
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="range"
        mixed={mixed}
        value={value}
      />
      <MixedValueInput
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        mixed={mixed}
        value={value}
      />
      <small>{suffix}</small>
    </label>
  );
}
