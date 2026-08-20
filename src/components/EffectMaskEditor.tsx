import type { EffectMask } from "../core/types";
import { useI18n } from "../i18n/react";

export function EffectMaskEditor({
  mask,
  onChange,
}: {
  mask: EffectMask;
  onChange: (mask: EffectMask) => void;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<EffectMask>) => onChange({ ...mask, ...patch });
  const updatePair = (key: "center" | "size", index: 0 | 1, value: number) => {
    if (!Number.isFinite(value)) return;
    const pair: [number, number] = [...mask[key]];
    pair[index] = value;
    update({ [key]: pair });
  };
  return (
    <div className="effect-mask-editor">
      <div className="effect-mask-heading">
        <strong>{t("mask.title")}</strong>
        <select
          aria-label={t("mask.shape")}
          onChange={(event) => update({ shape: event.target.value as EffectMask["shape"] })}
          value={mask.shape}
        >
          <option value="ellipse">{t("mask.ellipse")}</option>
          <option value="rectangle">{t("mask.rectangle")}</option>
        </select>
        <label>
          <input
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
        value={mask.center}
      />
      <MaskPair
        label={t("mask.size")}
        max={2000}
        min={0.1}
        onChange={(index, value) => updatePair("size", index, value)}
        value={mask.size}
      />
      <MaskScalar
        label={t("mask.feather")}
        max={500}
        min={0}
        onChange={(feather) => update({ feather })}
        step={1}
        suffix="px"
        value={mask.feather}
      />
      <MaskScalar
        label={t("mask.opacity")}
        max={100}
        min={0}
        onChange={(opacity) => update({ opacity })}
        step={1}
        suffix="%"
        value={mask.opacity}
      />
    </div>
  );
}

function MaskPair({
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
}) {
  return (
    <div className="effect-mask-pair">
      <span>{label}</span>
      {(["X", "Y"] as const).map((axis, index) => (
        <label key={axis}>
          {axis}
          <input
            max={max}
            min={min}
            onChange={(event) => onChange(index as 0 | 1, Number(event.target.value))}
            step="0.1"
            type="number"
            value={value[index]}
          />
          <small>%</small>
        </label>
      ))}
    </div>
  );
}

function MaskScalar({
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
}) {
  return (
    <label className="effect-mask-scalar">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="range"
        value={value}
      />
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
      <small>{suffix}</small>
    </label>
  );
}
