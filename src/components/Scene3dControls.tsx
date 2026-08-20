import { createDefaultParticleSettings } from "../core/particle-settings";
import type {
  CameraSettings,
  Layer,
  LightSettings,
  Material3d,
  ParticleSettings,
} from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { ParticleControls } from "./ParticleControls";

export function Scene3dControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();

  const updateMaterial = (field: keyof Material3d, value: number | string) => {
    if (typeof value === "number" && !Number.isFinite(value)) return;
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setMaterial3d",
          layerId: layer.id,
          material: {
            metallic: layer.material?.metallic ?? 0.18,
            roughness: layer.material?.roughness ?? 0.42,
            emissive: layer.material?.emissive ?? 0,
            alphaMode: layer.material?.alphaMode ?? "opaque",
            alphaCutoff: layer.material?.alphaCutoff ?? 0.5,
            [field]: value,
          },
        },
      ],
    });
  };

  const updateLight = (field: keyof LightSettings, value: string | number) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setLightSettings",
          layerId: layer.id,
          light: {
            kind: layer.light?.kind ?? "directional",
            intensity: layer.light?.intensity ?? 2.5,
            range: layer.light?.range ?? 2400,
            coneAngle: layer.light?.coneAngle ?? 45,
            shadowQuality: layer.light?.shadowQuality ?? "medium",
            [field]: value,
          },
        },
      ],
    });
  };

  const updateCamera = (field: keyof CameraSettings, value: string | number) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setCameraSettings",
          layerId: layer.id,
          camera: {
            projection: layer.camera?.projection ?? "perspective",
            fieldOfView: layer.camera?.fieldOfView ?? 50,
            orthographicSize: layer.camera?.orthographicSize ?? 2160,
            [field]: value,
          },
        },
      ],
    });
  };

  const updateParticle = (particle: ParticleSettings) => {
    const operations = [];
    if (particle.renderMode !== "mesh" && layer.blendMode !== "add")
      operations.push({
        type: "setBlendMode" as const,
        layerId: layer.id,
        blendMode: "add" as const,
      });
    operations.push({
      type: "setParticleSettings" as const,
      layerId: layer.id,
      particle,
    });
    dispatch({
      type: "operation",
      operations,
    });
  };

  if (layer.kind === "mesh") {
    return (
      <>
        <NumericControl
          label={t("scene3d.material.metallic")}
          max={1}
          min={0}
          onChange={(value) => updateMaterial("metallic", value)}
          step={0.01}
          value={layer.material?.metallic ?? 0.18}
        />
        <NumericControl
          label={t("scene3d.material.roughness")}
          max={1}
          min={0.04}
          onChange={(value) => updateMaterial("roughness", value)}
          step={0.01}
          value={layer.material?.roughness ?? 0.42}
        />
        <NumericControl
          label={t("scene3d.material.emissive")}
          max={16}
          min={0}
          onChange={(value) => updateMaterial("emissive", value)}
          step={0.05}
          value={layer.material?.emissive ?? 0}
        />
        <label>
          {t("scene3d.material.alphaMode")}
          <select
            aria-label={t("scene3d.material.alphaMode")}
            onChange={(event) => updateMaterial("alphaMode", event.target.value)}
            value={layer.material?.alphaMode ?? "opaque"}
          >
            <option value="opaque">{t("scene3d.alpha.opaque")}</option>
            <option value="mask">{t("scene3d.alpha.mask")}</option>
            <option value="blend">{t("scene3d.alpha.blend")}</option>
          </select>
        </label>
        {(layer.material?.alphaMode ?? "opaque") === "mask" && (
          <NumericControl
            label={t("scene3d.material.alphaCutoff")}
            max={1}
            min={0}
            onChange={(value) => updateMaterial("alphaCutoff", value)}
            step={0.01}
            value={layer.material?.alphaCutoff ?? 0.5}
          />
        )}
      </>
    );
  }

  if (layer.kind === "camera") {
    const projection = layer.camera?.projection ?? "perspective";
    return (
      <>
        <label>
          {t("scene3d.camera.projection")}
          <select
            aria-label={t("scene3d.camera.projectionA11y")}
            onChange={(event) => updateCamera("projection", event.target.value)}
            value={projection}
          >
            <option value="perspective">{t("scene3d.camera.perspective")}</option>
            <option value="orthographic">{t("scene3d.camera.orthographic")}</option>
          </select>
        </label>
        {projection === "perspective" ? (
          <NumericControl
            label={t("scene3d.camera.fieldOfView")}
            max={179}
            min={1}
            onChange={(value) => updateCamera("fieldOfView", value)}
            step={1}
            value={layer.camera?.fieldOfView ?? 50}
          />
        ) : (
          <NumericControl
            label={t("scene3d.camera.orthographicSize")}
            max={100_000}
            min={1}
            onChange={(value) => updateCamera("orthographicSize", value)}
            step={10}
            value={layer.camera?.orthographicSize ?? 2160}
          />
        )}
      </>
    );
  }

  if (layer.kind === "particle") {
    return (
      <ParticleControls
        onChange={updateParticle}
        settings={layer.particle ?? createDefaultParticleSettings()}
      />
    );
  }

  if (layer.kind !== "light") return null;
  const lightKind = layer.light?.kind ?? "directional";
  return (
    <>
      <label>
        {t("scene3d.light.type")}
        <select
          aria-label={t("scene3d.light.type")}
          onChange={(event) => updateLight("kind", event.target.value)}
          value={lightKind}
        >
          <option value="directional">{t("scene3d.light.directional")}</option>
          <option value="point">{t("scene3d.light.point")}</option>
          <option value="spot">{t("scene3d.light.spot")}</option>
        </select>
      </label>
      <NumericControl
        label={t("scene3d.light.intensity")}
        max={100}
        min={0}
        onChange={(value) => updateLight("intensity", value)}
        step={0.1}
        value={layer.light?.intensity ?? 2.5}
      />
      {(lightKind === "point" || lightKind === "spot") && (
        <NumericControl
          label={t("scene3d.light.range")}
          max={20_000}
          min={1}
          onChange={(value) => updateLight("range", value)}
          step={10}
          value={layer.light?.range ?? 2400}
        />
      )}
      {lightKind === "spot" && (
        <NumericControl
          label={t("scene3d.light.coneAngle")}
          max={179}
          min={1}
          onChange={(value) => updateLight("coneAngle", value)}
          step={1}
          value={layer.light?.coneAngle ?? 45}
        />
      )}
      <label>
        {t("scene3d.light.shadowQuality")}
        <select
          aria-label={t("scene3d.light.shadowQuality")}
          onChange={(event) => updateLight("shadowQuality", event.target.value)}
          value={layer.light?.shadowQuality ?? "medium"}
        >
          <option value="off">{t("scene3d.light.shadowOff")}</option>
          <option value="low">{t("scene3d.light.shadowLow")}</option>
          <option value="medium">{t("scene3d.light.shadowMedium")}</option>
          <option value="high">{t("scene3d.light.shadowHigh")}</option>
        </select>
      </label>
      <label>
        {t("scene3d.light.color")}
        <input
          aria-label={t("scene3d.light.color")}
          onChange={(event) => {
            const color = Number.parseInt(event.target.value.slice(1), 16);
            dispatch({
              type: "operation",
              operations: [
                {
                  type: "setLayerColor",
                  layerId: layer.id,
                  color: [
                    ((color >> 16) & 0xff) / 255,
                    ((color >> 8) & 0xff) / 255,
                    (color & 0xff) / 255,
                    layer.color[3],
                  ],
                },
              ],
            });
          }}
          type="color"
          value={rgbColorInput(layer.color)}
        />
      </label>
    </>
  );
}

function NumericControl({
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
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
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

function rgbColorInput(color: readonly [number, number, number, number]): string {
  return `#${color
    .slice(0, 3)
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
