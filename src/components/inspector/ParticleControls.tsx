import { PARTICLE_LIMITS, type ParticleSettings } from "../../core/scene/particle-settings";
import { useI18n } from "../../i18n/react";
import { valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";
import { type SettingsEdit, type SettingsRecipe, settingsEdit } from "./settings-edit";

interface ParticleControlsProps {
  settings: ParticleSettings;
  onChange: SettingsEdit<ParticleSettings>;
  selection?: readonly ParticleSettings[];
}

export function ParticleControls({
  settings,
  onChange,
  selection = [settings],
}: ParticleControlsProps) {
  const { t } = useI18n();
  const edit = settingsEdit(settings, onChange, selection.length);
  const update = <Key extends keyof ParticleSettings>(
    key: Key,
    value: ParticleSettings[Key],
    recipe?: SettingsRecipe<ParticleSettings[Key]>,
  ) =>
    edit((current, index) => ({ ...current, [key]: recipe ? recipe(current[key], index) : value }));

  return (
    <div className="particle-controls">
      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.system")}</legend>
        <label>
          {t("scene3d.particle.renderMode")}
          <MixedValueSelect
            aria-label={t("scene3d.particle.renderModeA11y")}
            onChange={(event) =>
              update("renderMode", event.target.value as ParticleSettings["renderMode"])
            }
            mixed={valuesDiffer(selection.map((entry) => entry.renderMode))}
            value={settings.renderMode}
          >
            <option value="billboard">{t("scene3d.particle.billboard")}</option>
            <option value="streak">{t("scene3d.particle.streak")}</option>
            <option value="mesh">{t("scene3d.particle.mesh")}</option>
          </MixedValueSelect>
        </label>
        {selection.every((entry) => entry.renderMode === "mesh") && (
          <label>
            {t("scene3d.particle.meshPrimitive")}
            <MixedValueSelect
              aria-label={t("scene3d.particle.meshPrimitiveA11y")}
              onChange={(event) =>
                update("meshPrimitive", event.target.value as ParticleSettings["meshPrimitive"])
              }
              mixed={valuesDiffer(selection.map((entry) => entry.meshPrimitive))}
              value={settings.meshPrimitive}
            >
              <option value="cube">{t("scene3d.particle.cube")}</option>
            </MixedValueSelect>
          </label>
        )}
        <NumberControl
          integer
          label={t("scene3d.particle.count")}
          onChange={(value) => update("count", value)}
          range={PARTICLE_LIMITS.count}
          step={10_000}
          mixed={valuesDiffer(selection.map((entry) => entry.count))}
          value={settings.count}
        />
        <NumberControl
          integer
          label={t("scene3d.particle.seed")}
          onChange={(value) => update("seed", value)}
          range={PARTICLE_LIMITS.seed}
          step={1}
          mixed={valuesDiffer(selection.map((entry) => entry.seed))}
          value={settings.seed}
        />
        <NumberControl
          label={t("scene3d.particle.lifetime")}
          onChange={(value) => update("lifetime", value)}
          range={PARTICLE_LIMITS.lifetime}
          step={0.1}
          mixed={valuesDiffer(selection.map((entry) => entry.lifetime))}
          value={settings.lifetime}
        />
      </fieldset>

      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.emitter")}</legend>
        <label>
          {t("scene3d.particle.emitterShape")}
          <MixedValueSelect
            aria-label={t("scene3d.particle.emitterShapeA11y")}
            onChange={(event) =>
              update("emitterShape", event.target.value as ParticleSettings["emitterShape"])
            }
            mixed={valuesDiffer(selection.map((entry) => entry.emitterShape))}
            value={settings.emitterShape}
          >
            <option value="point">{t("scene3d.particle.shape.point")}</option>
            <option value="box">{t("scene3d.particle.shape.box")}</option>
            <option value="sphere">{t("scene3d.particle.shape.sphere")}</option>
            <option value="ring">{t("scene3d.particle.shape.ring")}</option>
            <option value="line">{t("scene3d.particle.shape.line")}</option>
          </MixedValueSelect>
        </label>
        <VectorControl
          label={t("scene3d.particle.emitterPosition")}
          onChange={(value, recipe) => update("emitterPosition", value, recipe)}
          range={PARTICLE_LIMITS.emitterPosition}
          selection={selection.map((entry) => entry.emitterPosition)}
          value={settings.emitterPosition}
        />
        <VectorControl
          label={t("scene3d.particle.emitterSize")}
          onChange={(value, recipe) => update("emitterSize", value, recipe)}
          range={PARTICLE_LIMITS.emitterSize}
          selection={selection.map((entry) => entry.emitterSize)}
          value={settings.emitterSize}
        />
        <NumberControl
          label={t("scene3d.particle.emitterSpread")}
          onChange={(value) => update("emitterSpread", value)}
          range={PARTICLE_LIMITS.emitterSpread}
          step={1}
          mixed={valuesDiffer(selection.map((entry) => entry.emitterSpread))}
          value={settings.emitterSpread}
        />
      </fieldset>

      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.physics")}</legend>
        <VectorControl
          label={t("scene3d.particle.velocity")}
          onChange={(value, recipe) => update("velocity", value, recipe)}
          range={PARTICLE_LIMITS.velocity}
          selection={selection.map((entry) => entry.velocity)}
          value={settings.velocity}
        />
        <VectorControl
          label={t("scene3d.particle.gravity")}
          onChange={(value, recipe) => update("gravity", value, recipe)}
          range={PARTICLE_LIMITS.gravity}
          selection={selection.map((entry) => entry.gravity)}
          value={settings.gravity}
        />
        <NumberControl
          label={t("scene3d.particle.drag")}
          onChange={(value) => update("drag", value)}
          range={PARTICLE_LIMITS.drag}
          step={0.01}
          mixed={valuesDiffer(selection.map((entry) => entry.drag))}
          value={settings.drag}
        />
        <NumberControl
          label={t("scene3d.particle.turbulence")}
          onChange={(value) => update("turbulence", value)}
          range={PARTICLE_LIMITS.turbulence}
          step={0.01}
          mixed={valuesDiffer(selection.map((entry) => entry.turbulence))}
          value={settings.turbulence}
        />
        <NumberControl
          label={t("scene3d.particle.turbulenceScale")}
          onChange={(value) => update("turbulenceScale", value)}
          range={PARTICLE_LIMITS.turbulenceScale}
          step={0.1}
          mixed={valuesDiffer(selection.map((entry) => entry.turbulenceScale))}
          value={settings.turbulenceScale}
        />
      </fieldset>

      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.life")}</legend>
        <HdrColorControl
          label={t("scene3d.particle.startColor")}
          onChange={(value, recipe) => update("startColor", value, recipe)}
          selection={selection.map((entry) => entry.startColor)}
          value={settings.startColor}
        />
        <HdrColorControl
          label={t("scene3d.particle.endColor")}
          onChange={(value, recipe) => update("endColor", value, recipe)}
          selection={selection.map((entry) => entry.endColor)}
          value={settings.endColor}
        />
        <NumberControl
          label={t("scene3d.particle.startOpacity")}
          onChange={(value) => update("startOpacity", value)}
          range={PARTICLE_LIMITS.opacity}
          step={0.01}
          mixed={valuesDiffer(selection.map((entry) => entry.startOpacity))}
          value={settings.startOpacity}
        />
        <NumberControl
          label={t("scene3d.particle.endOpacity")}
          onChange={(value) => update("endOpacity", value)}
          range={PARTICLE_LIMITS.opacity}
          step={0.01}
          mixed={valuesDiffer(selection.map((entry) => entry.endOpacity))}
          value={settings.endOpacity}
        />
        <NumberControl
          label={t("scene3d.particle.startSize")}
          onChange={(value) => update("startSize", value)}
          range={PARTICLE_LIMITS.size}
          step={0.1}
          mixed={valuesDiffer(selection.map((entry) => entry.startSize))}
          value={settings.startSize}
        />
        <NumberControl
          label={t("scene3d.particle.endSize")}
          onChange={(value) => update("endSize", value)}
          range={PARTICLE_LIMITS.size}
          step={0.1}
          mixed={valuesDiffer(selection.map((entry) => entry.endSize))}
          value={settings.endSize}
        />
        <NumberControl
          label={t("scene3d.particle.startRotation")}
          onChange={(value) => update("startRotation", value)}
          range={PARTICLE_LIMITS.rotation}
          step={1}
          mixed={valuesDiffer(selection.map((entry) => entry.startRotation))}
          value={settings.startRotation}
        />
        <NumberControl
          label={t("scene3d.particle.endRotation")}
          onChange={(value) => update("endRotation", value)}
          range={PARTICLE_LIMITS.rotation}
          step={1}
          mixed={valuesDiffer(selection.map((entry) => entry.endRotation))}
          value={settings.endRotation}
        />
        {selection.every((entry) => entry.renderMode === "streak") && (
          <NumberControl
            label={t("scene3d.particle.streakLength")}
            onChange={(value) => update("streakLength", value)}
            range={PARTICLE_LIMITS.streakLength}
            step={0.05}
            mixed={valuesDiffer(selection.map((entry) => entry.streakLength))}
            value={settings.streakLength}
          />
        )}
      </fieldset>
    </div>
  );
}

function NumberControl({
  mixed,
  integer = false,
  label,
  onChange,
  range: [min, max],
  step,
  value,
}: {
  integer?: boolean;
  label: string;
  onChange: (value: number) => void;
  range: readonly [number, number];
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
        onChange={(event) => {
          const number = Number(event.target.value);
          if (Number.isFinite(number)) onChange(integer ? Math.round(number) : number);
        }}
        step={step}
        type="number"
        mixed={mixed}
        value={value}
      />
    </label>
  );
}

function VectorControl({
  label,
  onChange,
  range,
  value,
  selection = [value],
}: {
  label: string;
  onChange: SettingsEdit<[number, number, number]>;
  selection?: readonly (readonly [number, number, number])[];
  range: readonly [number, number];
  value: readonly [number, number, number];
}) {
  return (
    <fieldset className="particle-vector">
      <legend>{label}</legend>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <NumberControl
          key={axis}
          label={`${label} ${axis}`}
          onChange={(number) => {
            const recipe = (
              current: readonly [number, number, number],
            ): [number, number, number] => {
              const next: [number, number, number] = [...current];
              next[index] = number;
              return next;
            };
            onChange(recipe(value), recipe);
          }}
          range={range}
          step={0.01}
          mixed={valuesDiffer(selection.map((entry) => entry[index]))}
          value={value[index]}
        />
      ))}
    </fieldset>
  );
}

/** HDR channels stay numeric (0..16); an HTML color input would silently clamp them to SDR. */
function HdrColorControl({
  label,
  onChange,
  value,
  selection = [value],
}: {
  label: string;
  onChange: SettingsEdit<[number, number, number]>;
  selection?: readonly (readonly [number, number, number])[];
  value: readonly [number, number, number];
}) {
  return (
    <fieldset className="particle-vector particle-hdr-color">
      <legend>{label}</legend>
      {(["R", "G", "B"] as const).map((channel, index) => (
        <NumberControl
          key={channel}
          label={`${label} ${channel}`}
          onChange={(number) => {
            const recipe = (
              current: readonly [number, number, number],
            ): [number, number, number] => {
              const next: [number, number, number] = [...current];
              next[index] = number;
              return next;
            };
            onChange(recipe(value), recipe);
          }}
          range={PARTICLE_LIMITS.color}
          step={0.05}
          mixed={valuesDiffer(selection.map((entry) => entry[index]))}
          value={value[index]}
        />
      ))}
    </fieldset>
  );
}
