import { PARTICLE_LIMITS, type ParticleSettings } from "../../core/scene/particle-settings";
import { useI18n } from "../../i18n/react";

interface ParticleControlsProps {
  settings: ParticleSettings;
  onChange: (settings: ParticleSettings) => void;
}

export function ParticleControls({ settings, onChange }: ParticleControlsProps) {
  const { t } = useI18n();
  const update = <Key extends keyof ParticleSettings>(key: Key, value: ParticleSettings[Key]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="particle-controls">
      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.system")}</legend>
        <label>
          {t("scene3d.particle.renderMode")}
          <select
            aria-label={t("scene3d.particle.renderModeA11y")}
            onChange={(event) =>
              update("renderMode", event.target.value as ParticleSettings["renderMode"])
            }
            value={settings.renderMode}
          >
            <option value="billboard">{t("scene3d.particle.billboard")}</option>
            <option value="streak">{t("scene3d.particle.streak")}</option>
            <option value="mesh">{t("scene3d.particle.mesh")}</option>
          </select>
        </label>
        {settings.renderMode === "mesh" && (
          <label>
            {t("scene3d.particle.meshPrimitive")}
            <select
              aria-label={t("scene3d.particle.meshPrimitiveA11y")}
              onChange={(event) =>
                update("meshPrimitive", event.target.value as ParticleSettings["meshPrimitive"])
              }
              value={settings.meshPrimitive}
            >
              <option value="cube">{t("scene3d.particle.cube")}</option>
            </select>
          </label>
        )}
        <NumberControl
          integer
          label={t("scene3d.particle.count")}
          onChange={(value) => update("count", value)}
          range={PARTICLE_LIMITS.count}
          step={10_000}
          value={settings.count}
        />
        <NumberControl
          integer
          label={t("scene3d.particle.seed")}
          onChange={(value) => update("seed", value)}
          range={PARTICLE_LIMITS.seed}
          step={1}
          value={settings.seed}
        />
        <NumberControl
          label={t("scene3d.particle.lifetime")}
          onChange={(value) => update("lifetime", value)}
          range={PARTICLE_LIMITS.lifetime}
          step={0.1}
          value={settings.lifetime}
        />
      </fieldset>

      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.emitter")}</legend>
        <label>
          {t("scene3d.particle.emitterShape")}
          <select
            aria-label={t("scene3d.particle.emitterShapeA11y")}
            onChange={(event) =>
              update("emitterShape", event.target.value as ParticleSettings["emitterShape"])
            }
            value={settings.emitterShape}
          >
            <option value="point">{t("scene3d.particle.shape.point")}</option>
            <option value="box">{t("scene3d.particle.shape.box")}</option>
            <option value="sphere">{t("scene3d.particle.shape.sphere")}</option>
            <option value="ring">{t("scene3d.particle.shape.ring")}</option>
            <option value="line">{t("scene3d.particle.shape.line")}</option>
          </select>
        </label>
        <VectorControl
          label={t("scene3d.particle.emitterPosition")}
          onChange={(value) => update("emitterPosition", value)}
          range={PARTICLE_LIMITS.emitterPosition}
          value={settings.emitterPosition}
        />
        <VectorControl
          label={t("scene3d.particle.emitterSize")}
          onChange={(value) => update("emitterSize", value)}
          range={PARTICLE_LIMITS.emitterSize}
          value={settings.emitterSize}
        />
        <NumberControl
          label={t("scene3d.particle.emitterSpread")}
          onChange={(value) => update("emitterSpread", value)}
          range={PARTICLE_LIMITS.emitterSpread}
          step={1}
          value={settings.emitterSpread}
        />
      </fieldset>

      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.physics")}</legend>
        <VectorControl
          label={t("scene3d.particle.velocity")}
          onChange={(value) => update("velocity", value)}
          range={PARTICLE_LIMITS.velocity}
          value={settings.velocity}
        />
        <VectorControl
          label={t("scene3d.particle.gravity")}
          onChange={(value) => update("gravity", value)}
          range={PARTICLE_LIMITS.gravity}
          value={settings.gravity}
        />
        <NumberControl
          label={t("scene3d.particle.drag")}
          onChange={(value) => update("drag", value)}
          range={PARTICLE_LIMITS.drag}
          step={0.01}
          value={settings.drag}
        />
        <NumberControl
          label={t("scene3d.particle.turbulence")}
          onChange={(value) => update("turbulence", value)}
          range={PARTICLE_LIMITS.turbulence}
          step={0.01}
          value={settings.turbulence}
        />
        <NumberControl
          label={t("scene3d.particle.turbulenceScale")}
          onChange={(value) => update("turbulenceScale", value)}
          range={PARTICLE_LIMITS.turbulenceScale}
          step={0.1}
          value={settings.turbulenceScale}
        />
      </fieldset>

      <fieldset className="particle-section">
        <legend>{t("scene3d.particle.section.life")}</legend>
        <HdrColorControl
          label={t("scene3d.particle.startColor")}
          onChange={(value) => update("startColor", value)}
          value={settings.startColor}
        />
        <HdrColorControl
          label={t("scene3d.particle.endColor")}
          onChange={(value) => update("endColor", value)}
          value={settings.endColor}
        />
        <NumberControl
          label={t("scene3d.particle.startOpacity")}
          onChange={(value) => update("startOpacity", value)}
          range={PARTICLE_LIMITS.opacity}
          step={0.01}
          value={settings.startOpacity}
        />
        <NumberControl
          label={t("scene3d.particle.endOpacity")}
          onChange={(value) => update("endOpacity", value)}
          range={PARTICLE_LIMITS.opacity}
          step={0.01}
          value={settings.endOpacity}
        />
        <NumberControl
          label={t("scene3d.particle.startSize")}
          onChange={(value) => update("startSize", value)}
          range={PARTICLE_LIMITS.size}
          step={0.1}
          value={settings.startSize}
        />
        <NumberControl
          label={t("scene3d.particle.endSize")}
          onChange={(value) => update("endSize", value)}
          range={PARTICLE_LIMITS.size}
          step={0.1}
          value={settings.endSize}
        />
        <NumberControl
          label={t("scene3d.particle.startRotation")}
          onChange={(value) => update("startRotation", value)}
          range={PARTICLE_LIMITS.rotation}
          step={1}
          value={settings.startRotation}
        />
        <NumberControl
          label={t("scene3d.particle.endRotation")}
          onChange={(value) => update("endRotation", value)}
          range={PARTICLE_LIMITS.rotation}
          step={1}
          value={settings.endRotation}
        />
        {settings.renderMode === "streak" && (
          <NumberControl
            label={t("scene3d.particle.streakLength")}
            onChange={(value) => update("streakLength", value)}
            range={PARTICLE_LIMITS.streakLength}
            step={0.05}
            value={settings.streakLength}
          />
        )}
      </fieldset>
    </div>
  );
}

function NumberControl({
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
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => {
          const number = Number(event.target.value);
          if (Number.isFinite(number)) onChange(integer ? Math.round(number) : number);
        }}
        step={step}
        type="number"
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
}: {
  label: string;
  onChange: (value: [number, number, number]) => void;
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
            const next = [...value] as [number, number, number];
            next[index] = number;
            onChange(next);
          }}
          range={range}
          step={0.01}
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
}: {
  label: string;
  onChange: (value: [number, number, number]) => void;
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
            const next = [...value] as [number, number, number];
            next[index] = number;
            onChange(next);
          }}
          range={PARTICLE_LIMITS.color}
          step={0.05}
          value={value[index]}
        />
      ))}
    </fieldset>
  );
}
