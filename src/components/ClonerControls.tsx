import {
  type ClonerEffector,
  type ClonerSettings,
  type GridClonerDistribution,
  normalizeClonerSettings,
  type RadialClonerDistribution,
} from "../core/cloner";
import type { Layer } from "../core/types";
import { createId } from "../core/types";
import { useEditor } from "../state/editor-store";

type EffectorKind = ClonerEffector["kind"];
type Vector3 = [number, number, number];

const DEFAULT_CLONER: ClonerSettings = {
  distribution: { kind: "grid", count: [3, 1, 1], spacing: [240, 0, 0] },
  effectors: [],
};

export function ClonerControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
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
          aria-label="Enable cloner"
          checked={Boolean(settings)}
          onChange={(event) =>
            update(event.target.checked ? structuredClone(DEFAULT_CLONER) : undefined)
          }
          type="checkbox"
        />
        Enable procedural cloner
      </label>
      {settings && (
        <>
          <label>
            Distribution
            <select
              aria-label="Cloner distribution"
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
              <option value="grid">Grid</option>
              <option value="radial">Radial</option>
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
                + {kind}
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
  return (
    <>
      <VectorInput
        integer
        label="Grid count"
        max={512}
        min={1}
        onChange={(count) => onChange({ ...distribution, count })}
        value={distribution.count}
      />
      <VectorInput
        label="Grid spacing"
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
  return (
    <>
      <NumberInput
        label="Clone count"
        max={65_536}
        min={1}
        onChange={(count) => onChange({ ...distribution, count: Math.round(count) })}
        step={1}
        value={distribution.count}
      />
      <NumberInput
        label="Radius"
        min={0}
        onChange={(radius) => onChange({ ...distribution, radius })}
        value={distribution.radius}
      />
      <NumberInput
        label="Start angle"
        onChange={(startAngle) => onChange({ ...distribution, startAngle })}
        value={distribution.startAngle}
      />
      <NumberInput
        label="End angle"
        onChange={(endAngle) => onChange({ ...distribution, endAngle })}
        value={distribution.endAngle}
      />
      <label>
        Axis
        <select
          aria-label="Radial cloner axis"
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
        Align clone rotation
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
  const vector = (field: "position" | "scale" | "rotation", value: Vector3) => {
    if (!(field in effector)) return;
    onChange({ ...effector, [field]: value } as ClonerEffector);
  };
  return (
    <div className="cloner-effector">
      <div>
        <strong>{effector.kind} effector</strong>
        <button aria-label={`Remove ${effector.kind} effector`} onClick={onRemove} type="button">
          Remove
        </button>
      </div>
      <label className="compositing-check">
        <input
          checked={effector.enabled}
          onChange={(event) => onChange({ ...effector, enabled: event.target.checked })}
          type="checkbox"
        />
        Enabled
      </label>
      <NumberInput
        label="Strength"
        max={4}
        min={-4}
        onChange={(strength) => onChange({ ...effector, strength })}
        step={0.05}
        value={effector.strength}
      />
      {effector.kind === "random" && (
        <NumberInput
          label="Seed"
          onChange={(seed) => onChange({ ...effector, seed: Math.round(seed) })}
          step={1}
          value={effector.seed}
        />
      )}
      {(effector.kind === "position" ||
        effector.kind === "scale" ||
        effector.kind === "rotation") && (
        <VectorInput
          label={effector.kind}
          onChange={(value) => onChange({ ...effector, value })}
          value={effector.value}
        />
      )}
      {(effector.kind === "random" || effector.kind === "audio") && (
        <>
          <VectorInput
            label="Position"
            onChange={(value) => vector("position", value)}
            value={effector.position}
          />
          <VectorInput
            label="Scale"
            onChange={(value) => vector("scale", value)}
            value={effector.scale}
          />
          <VectorInput
            label="Rotation"
            onChange={(value) => vector("rotation", value)}
            value={effector.rotation}
          />
        </>
      )}
      {effector.kind === "audio" && (
        <>
          <VectorInput
            dimensions={["Low Hz", "High Hz"]}
            label="Frequency band"
            min={0}
            onChange={(band) => onChange({ ...effector, band: [band[0], band[1]] })}
            value={[effector.band[0], effector.band[1], 0]}
          />
          <NumberInput
            label="Audio gain"
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
