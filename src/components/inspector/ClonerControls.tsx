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
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";
import { type SettingsEdit, type SettingsRecipe, settingsEdit } from "./settings-edit";

type EffectorKind = ClonerEffector["kind"];
type Vector3 = [number, number, number];

const DEFAULT_CLONER: ClonerSettings = {
  distribution: { kind: "grid", count: [3, 1, 1], spacing: [240, 0, 0] },
  effectors: [],
};

export function ClonerControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  const selection = layers.flatMap((entry) => (entry.cloner ? [entry.cloner] : []));
  if (layer.kind === "camera" || layer.kind === "light") return null;
  const settings = layer.cloner;
  const update = (cloner?: ClonerSettings, recipe?: SettingsRecipe<ClonerSettings>) => {
    dispatch({
      type: "operation",
      operations: editable.map((entry, index) => ({
        type: "setClonerSettings",
        layerId: entry.id,
        cloner: recipe && entry.cloner ? recipe(entry.cloner, index) : cloner,
      })),
    });
  };
  const edit = settingsEdit(settings ?? DEFAULT_CLONER, update, selection.length);
  const updateEffector = (
    index: number,
    next: ClonerEffector,
    recipe?: SettingsRecipe<ClonerEffector>,
  ) =>
    edit((current, targetIndex) => ({
      ...current,
      effectors: current.effectors.map((effector, candidate) =>
        candidate === index ? (recipe ? recipe(effector, targetIndex) : next) : effector,
      ),
    }));
  return (
    <div className="cloner-controls">
      <label className="compositing-check">
        <MixedValueInput
          aria-label={t("cloner.enableA11y")}
          mixed={valuesDiffer(layers.map((entry) => Boolean(entry.cloner)))}
          checked={Boolean(settings)}
          onChange={(event) =>
            dispatch({
              type: "operation",
              operations: editable.map((entry) => ({
                type: "setClonerSettings",
                layerId: entry.id,
                cloner: event.target.checked
                  ? (entry.cloner ?? structuredClone(DEFAULT_CLONER))
                  : undefined,
              })),
            })
          }
          type="checkbox"
        />
        {t("cloner.enable")}
      </label>
      {settings && selection.length === layers.length && (
        <>
          <label>
            {t("cloner.distribution")}
            <MixedValueSelect
              aria-label={t("cloner.distributionA11y")}
              onChange={(event) =>
                edit((current) => ({
                  ...current,
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
                }))
              }
              mixed={valuesDiffer(selection.map((entry) => entry.distribution.kind))}
              value={settings.distribution.kind}
            >
              <option value="grid">{t("cloner.grid")}</option>
              <option value="radial">{t("cloner.radial")}</option>
            </MixedValueSelect>
          </label>
          {settings.distribution.kind === "grid" &&
          selection.every((entry) => entry.distribution.kind === "grid") ? (
            <GridDistributionEditor
              distribution={settings.distribution}
              selection={selection.map(
                (entry) => entry.distribution as typeof settings.distribution,
              )}
              onChange={(distribution, recipe) =>
                edit((current, index) => ({
                  ...current,
                  distribution: recipe
                    ? recipe(current.distribution as typeof distribution, index)
                    : distribution,
                }))
              }
            />
          ) : settings.distribution.kind === "radial" &&
            selection.every((entry) => entry.distribution.kind === "radial") ? (
            <RadialDistributionEditor
              distribution={settings.distribution}
              selection={selection.map(
                (entry) => entry.distribution as typeof settings.distribution,
              )}
              onChange={(distribution, recipe) =>
                edit((current, index) => ({
                  ...current,
                  distribution: recipe
                    ? recipe(current.distribution as typeof distribution, index)
                    : distribution,
                }))
              }
            />
          ) : null}
          <div className="cloner-effector-actions">
            {(["position", "scale", "rotation", "random", "audio"] as const).map((kind) => (
              <button
                className="control-button"
                disabled={selection.some((entry) => entry.effectors.length >= 32)}
                key={kind}
                onClick={() =>
                  edit((current) => ({
                    ...current,
                    effectors: [...current.effectors, createClonerEffector(kind)],
                  }))
                }
                type="button"
              >
                + {effectorLabel(t, kind)}
              </button>
            ))}
          </div>
          {settings.effectors.map(
            (effector, index) =>
              selection.every((entry) => entry.effectors[index]?.kind === effector.kind) && (
                <EffectorEditor
                  effector={effector}
                  selection={selection.map((entry) => entry.effectors[index] as ClonerEffector)}
                  key={effector.id}
                  onChange={(next, recipe) => updateEffector(index, next, recipe)}
                  onRemove={() =>
                    edit((current) => ({
                      ...current,
                      effectors: current.effectors.filter((_, candidate) => candidate !== index),
                    }))
                  }
                />
              ),
          )}
        </>
      )}
    </div>
  );
}

function GridDistributionEditor({
  distribution,
  selection = [distribution],
  onChange,
}: {
  distribution: GridClonerDistribution;
  onChange: SettingsEdit<GridClonerDistribution>;
  selection?: readonly GridClonerDistribution[];
}) {
  const { t } = useI18n();
  const edit = settingsEdit(distribution, onChange, selection.length);
  return (
    <>
      <VectorInput
        integer
        label={t("cloner.gridCount")}
        max={512}
        min={1}
        onChange={(count, recipe) =>
          edit((current, index) => ({
            ...current,
            count: recipe ? recipe(current.count, index) : count,
          }))
        }
        selection={selection.map((entry) => entry.count)}
        value={distribution.count}
      />
      <VectorInput
        label={t("cloner.gridSpacing")}
        onChange={(spacing, recipe) =>
          edit((current, index) => ({
            ...current,
            spacing: recipe ? recipe(current.spacing, index) : spacing,
          }))
        }
        selection={selection.map((entry) => entry.spacing)}
        value={distribution.spacing}
      />
    </>
  );
}

function RadialDistributionEditor({
  distribution,
  selection = [distribution],
  onChange,
}: {
  distribution: RadialClonerDistribution;
  onChange: SettingsEdit<RadialClonerDistribution>;
  selection?: readonly RadialClonerDistribution[];
}) {
  const { t } = useI18n();
  const edit = settingsEdit(distribution, onChange, selection.length);
  return (
    <>
      <NumberInput
        label={t("cloner.cloneCount")}
        max={65_536}
        min={1}
        onChange={(count) => edit((current) => ({ ...current, count: Math.round(count) }))}
        step={1}
        mixed={valuesDiffer(selection.map((entry) => entry.count))}
        value={distribution.count}
      />
      <NumberInput
        label={t("cloner.radius")}
        min={0}
        onChange={(radius) => edit((current) => ({ ...current, radius }))}
        mixed={valuesDiffer(selection.map((entry) => entry.radius))}
        value={distribution.radius}
      />
      <NumberInput
        label={t("cloner.startAngle")}
        onChange={(startAngle) => edit((current) => ({ ...current, startAngle }))}
        mixed={valuesDiffer(selection.map((entry) => entry.startAngle))}
        value={distribution.startAngle}
      />
      <NumberInput
        label={t("cloner.endAngle")}
        onChange={(endAngle) => edit((current) => ({ ...current, endAngle }))}
        mixed={valuesDiffer(selection.map((entry) => entry.endAngle))}
        value={distribution.endAngle}
      />
      <label>
        {t("cloner.axis")}
        <MixedValueSelect
          aria-label={t("cloner.axisA11y")}
          onChange={(event) =>
            edit((current) => ({ ...current, axis: event.target.value as "x" | "y" | "z" }))
          }
          mixed={valuesDiffer(selection.map((entry) => entry.axis))}
          value={distribution.axis}
        >
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </MixedValueSelect>
      </label>
      <label className="compositing-check">
        <MixedValueInput
          mixed={valuesDiffer(selection.map((entry) => entry.alignRotation))}
          checked={distribution.alignRotation}
          onChange={(event) =>
            edit((current) => ({ ...current, alignRotation: event.target.checked }))
          }
          type="checkbox"
        />
        {t("cloner.alignRotation")}
      </label>
    </>
  );
}

function EffectorEditor({
  effector,
  selection = [effector],
  onChange,
  onRemove,
}: {
  effector: ClonerEffector;
  onChange: SettingsEdit<ClonerEffector>;
  selection?: readonly ClonerEffector[];
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const kindLabel = effectorLabel(t, effector.kind);
  const edit = settingsEdit(effector, onChange, selection.length);
  const vector = (
    field: "position" | "scale" | "rotation",
    value: Vector3,
    recipe?: SettingsRecipe<Vector3>,
  ) =>
    edit((current, index) => {
      if (!(field in current)) return current;
      return {
        ...current,
        [field]: recipe ? recipe(Reflect.get(current, field) as Vector3, index) : value,
      } as ClonerEffector;
    });
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
        <MixedValueInput
          mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "enabled")))}
          checked={effector.enabled}
          onChange={(event) => edit((current) => ({ ...current, enabled: event.target.checked }))}
          type="checkbox"
        />
        {t("common.enabled")}
      </label>
      <NumberInput
        label={t("cloner.strength")}
        max={4}
        min={-4}
        onChange={(strength) => edit((current) => ({ ...current, strength }))}
        step={0.05}
        mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "strength")))}
        value={effector.strength}
      />
      {effector.kind === "random" && (
        <NumberInput
          label={t("cloner.seed")}
          onChange={(seed) => edit((current) => ({ ...current, seed: Math.round(seed) }))}
          step={1}
          mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "seed")))}
          value={effector.seed}
        />
      )}
      {(effector.kind === "position" ||
        effector.kind === "scale" ||
        effector.kind === "rotation") && (
        <VectorInput
          label={kindLabel}
          onChange={(value, recipe) =>
            edit((current, index) => ({
              ...current,
              value: recipe && "value" in current ? recipe(current.value, index) : value,
            }))
          }
          selection={selection.map((entry) => Reflect.get(entry, "value") as Vector3)}
          value={effector.value}
        />
      )}
      {(effector.kind === "random" || effector.kind === "audio") && (
        <>
          <VectorInput
            label={t("cloner.position")}
            onChange={(value, recipe) => vector("position", value, recipe)}
            selection={selection.map((entry) => Reflect.get(entry, "position") as Vector3)}
            value={effector.position}
          />
          <VectorInput
            label={t("cloner.scale")}
            onChange={(value, recipe) => vector("scale", value, recipe)}
            selection={selection.map((entry) => Reflect.get(entry, "scale") as Vector3)}
            value={effector.scale}
          />
          <VectorInput
            label={t("cloner.rotation")}
            onChange={(value, recipe) => vector("rotation", value, recipe)}
            selection={selection.map((entry) => Reflect.get(entry, "rotation") as Vector3)}
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
            onChange={(band, recipe) =>
              edit((current, index) => {
                const next =
                  recipe && current.kind === "audio"
                    ? recipe([current.band[0], current.band[1], 0], index)
                    : band;
                return { ...current, band: [next[0], next[1]] };
              })
            }
            selection={selection.map((entry) =>
              entry.kind === "audio" ? [entry.band[0], entry.band[1], 0] : [0, 0, 0],
            )}
            value={[effector.band[0], effector.band[1], 0]}
          />
          <NumberInput
            label={t("audio.gain")}
            min={0}
            onChange={(gain) => edit((current) => ({ ...current, gain }))}
            mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "gain")))}
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
  selection = [value],
  onChange,
  dimensions = ["X", "Y", "Z"],
  integer = false,
  min,
  max,
}: {
  label: string;
  value: Vector3;
  onChange: SettingsEdit<Vector3>;
  selection?: readonly Vector3[];
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
          <MixedValueInput
            max={max}
            min={min}
            onChange={(event) => {
              const recipe = (current: Vector3): Vector3 => {
                const next: Vector3 = [...current];
                const number = Number(event.target.value);
                next[axis] = integer ? Math.round(number) : number;
                return next;
              };
              onChange(recipe(value), recipe);
            }}
            step={integer ? 1 : 0.1}
            type="number"
            mixed={valuesDiffer(selection.map((entry) => entry[axis]))}
            value={value[axis]}
          />
        </label>
      ))}
    </fieldset>
  );
}

function NumberInput({
  mixed,
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
}: {
  label: string;
  value: number;
  mixed?: boolean;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <MixedValueInput
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
