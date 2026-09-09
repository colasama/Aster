import {
  type ClonerEffector,
  type ClonerSettings,
  type GridClonerDistribution,
  normalizeClonerSettings,
  type RadialClonerDistribution,
} from "../../core/scene/cloner";
import type { Layer } from "../../core/types";
import { createId } from "../../core/types";
import type { PlainMessageKey, Translate } from "../../i18n/core";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";

type EffectorKind = ClonerEffector["kind"];
type Vector3 = [number, number, number];

const DEFAULT_CLONER: ClonerSettings = {
  distribution: { kind: "grid", count: [3, 1, 1], spacing: [240, 0, 0] },
  effectors: [],
};

export function ClonerControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  if (layer.kind === "camera" || layer.kind === "light") return null;
  const settings = layer.cloner;
  const update = (cloner?: ClonerSettings) => {
    dispatch({
      type: "operation",
      operations: [{ type: "setClonerSettings", layerId: layer.id, cloner }],
    });
  };
  const updateEffector = (id: string, next: ClonerEffector) => {
    if (!settings) return;
    update({
      ...settings,
      effectors: settings.effectors.map((effector) => (effector.id === id ? next : effector)),
    });
  };

  return (
    <div className="cloner-controls">
      <label className="compositing-check">
        <input
          aria-label={t("cloner.enableA11y")}
          checked={Boolean(settings)}
          onChange={(event) =>
            update(event.target.checked ? structuredClone(DEFAULT_CLONER) : undefined)
          }
          type="checkbox"
        />
        {t("cloner.enable")}
      </label>
      {settings && (
        <>
          <label>
            {t("cloner.distribution")}
            <select
              aria-label={t("cloner.distributionA11y")}
              onChange={(event) =>
                update({
                  ...settings,
                  distribution:
                    event.target.value === "radial"
                      ? {
                          kind: "radial",
                          count: 8,
                          radius: 320,
                          startAngle: 0,
                          endAngle: 360,
                          axis: "z",
                          alignRotation: true,
                        }
                      : structuredClone(DEFAULT_CLONER.distribution),
                })
              }
              value={settings.distribution.kind}
            >
              <option value="grid">{t("cloner.grid")}</option>
              <option value="radial">{t("cloner.radial")}</option>
            </select>
          </label>
          {settings.distribution.kind === "grid" ? (
            <GridDistributionEditor
              distribution={settings.distribution}
              onChange={(distribution) => update({ ...settings, distribution })}
            />
          ) : (
            <RadialDistributionEditor
              distribution={settings.distribution}
              onChange={(distribution) => update({ ...settings, distribution })}
            />
          )}
          <div className="cloner-effector-actions">
            {(["position", "scale", "rotation", "random", "audio"] as const).map((kind) => (
              <button
                className="control-button"
                disabled={settings.effectors.length >= 32}
                key={kind}
                onClick={() =>
                  update({
                    ...settings,
                    effectors: [...settings.effectors, createClonerEffector(kind)],
                  })
                }
                type="button"
              >
                + {effectorLabel(t, kind)}
              </button>
            ))}
          </div>
          {settings.effectors.map((effector) => (
            <EffectorEditor
              effector={effector}
              key={effector.id}
              onChange={(next) => updateEffector(effector.id, next)}
              onRemove={() =>
                update({
                  ...settings,
                  effectors: settings.effectors.filter((candidate) => candidate.id !== effector.id),
                })
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

function GridDistributionEditor({
  distribution,
  onChange,
}: {
  distribution: GridClonerDistribution;
  onChange: (value: GridClonerDistribution) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <VectorInput
        integer
        label={t("cloner.gridCount")}
        max={512}
        min={1}
        onChange={(count) => onChange({ ...distribution, count })}
        value={distribution.count}
      />
      <VectorInput
        label={t("cloner.gridSpacing")}
        onChange={(spacing) => onChange({ ...distribution, spacing })}
        value={distribution.spacing}
      />
    </>
  );
}

function RadialDistributionEditor({
  distribution,
  onChange,
}: {
  distribution: RadialClonerDistribution;
  onChange: (value: RadialClonerDistribution) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <NumberInput
        label={t("cloner.cloneCount")}
        max={65_536}
        min={1}
        onChange={(count) => onChange({ ...distribution, count: Math.round(count) })}
        step={1}
        value={distribution.count}
      />
      <NumberInput
        label={t("cloner.radius")}
        min={0}
        onChange={(radius) => onChange({ ...distribution, radius })}
        value={distribution.radius}
      />
      <NumberInput
        label={t("cloner.startAngle")}
        onChange={(startAngle) => onChange({ ...distribution, startAngle })}
        value={distribution.startAngle}
      />
      <NumberInput
        label={t("cloner.endAngle")}
        onChange={(endAngle) => onChange({ ...distribution, endAngle })}
        value={distribution.endAngle}
      />
      <label>
        {t("cloner.axis")}
        <select
          aria-label={t("cloner.axisA11y")}
          onChange={(event) =>
            onChange({ ...distribution, axis: event.target.value as "x" | "y" | "z" })
          }
          value={distribution.axis}
        >
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      </label>
      <label className="compositing-check">
        <input
          checked={distribution.alignRotation}
          onChange={(event) => onChange({ ...distribution, alignRotation: event.target.checked })}
          type="checkbox"
        />
        {t("cloner.alignRotation")}
      </label>
    </>
  );
}

function EffectorEditor({
  effector,
  onChange,
  onRemove,
}: {
  effector: ClonerEffector;
  onChange: (value: ClonerEffector) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const kindLabel = effectorLabel(t, effector.kind);
  const vector = (field: "position" | "scale" | "rotation", value: Vector3) => {
    if (!(field in effector)) return;
    onChange({ ...effector, [field]: value } as ClonerEffector);
  };
  return (
    <div className="cloner-effector">
      <div>
        <strong>{t("cloner.effectorTitle", { kind: kindLabel })}</strong>
        <button
          aria-label={t("cloner.effectorRemove", { kind: kindLabel })}
          className="control-button"
          onClick={onRemove}
          type="button"
        >
          {t("common.remove")}
        </button>
      </div>
      <label className="compositing-check">
        <input
          checked={effector.enabled}
          onChange={(event) => onChange({ ...effector, enabled: event.target.checked })}
          type="checkbox"
        />
        {t("common.enabled")}
      </label>
      <NumberInput
        label={t("cloner.strength")}
        max={4}
        min={-4}
        onChange={(strength) => onChange({ ...effector, strength })}
        step={0.05}
        value={effector.strength}
      />
      {effector.kind === "random" && (
        <NumberInput
          label={t("cloner.seed")}
          onChange={(seed) => onChange({ ...effector, seed: Math.round(seed) })}
          step={1}
          value={effector.seed}
        />
      )}
      {(effector.kind === "position" ||
        effector.kind === "scale" ||
        effector.kind === "rotation") && (
        <VectorInput
          label={kindLabel}
          onChange={(value) => onChange({ ...effector, value })}
          value={effector.value}
        />
      )}
      {(effector.kind === "random" || effector.kind === "audio") && (
        <>
          <VectorInput
            label={t("cloner.position")}
            onChange={(value) => vector("position", value)}
            value={effector.position}
          />
          <VectorInput
            label={t("cloner.scale")}
            onChange={(value) => vector("scale", value)}
            value={effector.scale}
          />
          <VectorInput
            label={t("cloner.rotation")}
            onChange={(value) => vector("rotation", value)}
            value={effector.rotation}
          />
        </>
      )}
      {effector.kind === "audio" && (
        <>
          <VectorInput
            dimensions={[t("cloner.lowHz"), t("cloner.highHz")]}
            label={t("cloner.frequencyBand")}
            min={0}
            onChange={(band) => onChange({ ...effector, band: [band[0], band[1]] })}
            value={[effector.band[0], effector.band[1], 0]}
          />
          <NumberInput
            label={t("audio.gain")}
            min={0}
            onChange={(gain) => onChange({ ...effector, gain })}
            value={effector.gain}
          />
        </>
      )}
    </div>
  );
}

function VectorInput({
  label,
  value,
  onChange,
  dimensions = ["X", "Y", "Z"],
  integer = false,
  min,
  max,
}: {
  label: string;
  value: Vector3;
  onChange: (value: Vector3) => void;
  dimensions?: readonly string[];
  integer?: boolean;
  min?: number;
  max?: number;
}) {
  return (
    <fieldset className="cloner-vector">
      <legend>{label}</legend>
      {dimensions.map((dimension, axis) => (
        <label key={dimension}>
          {dimension}
          <input
            max={max}
            min={min}
            onChange={(event) => {
              const next = [...value] as Vector3;
              const number = Number(event.target.value);
              next[axis] = integer ? Math.round(number) : number;
              onChange(next);
            }}
            step={integer ? 1 : 0.1}
            type="number"
            value={value[axis]}
          />
        </label>
      ))}
    </fieldset>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

export function createClonerEffector(kind: EffectorKind): ClonerEffector {
  const base = { id: createId(), enabled: true, strength: 1 };
  if (kind === "position") return { ...base, kind, value: [120, 0, 0] };
  if (kind === "scale") return { ...base, kind, value: [120, 120, 120] };
  if (kind === "rotation") return { ...base, kind, value: [0, 0, 30] };
  if (kind === "audio")
    return {
      ...base,
      kind,
      band: [80, 240],
      gain: 1,
      position: [0, -80, 0],
      scale: [30, 30, 30],
      rotation: [0, 0, 20],
    };
  return {
    ...base,
    kind,
    seed: 13_337,
    position: [120, 120, 0],
    scale: [20, 20, 20],
    rotation: [0, 0, 45],
  };
}

export function normalizedDefaultCloner(): ClonerSettings {
  return normalizeClonerSettings(structuredClone(DEFAULT_CLONER));
}

function effectorLabel(t: Translate, kind: EffectorKind): string {
  const keys: Record<EffectorKind, PlainMessageKey> = {
    position: "cloner.effector.position",
    scale: "cloner.effector.scale",
    rotation: "cloner.effector.rotation",
    random: "cloner.effector.random",
    audio: "cloner.effector.audio",
  };
  return t(keys[kind]);
}
