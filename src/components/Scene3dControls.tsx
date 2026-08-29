import { useSyncExternalStore } from "react";
import {
  createParticleSceneGenerator,
  particleSettingsFromGenerator,
} from "../core/bundled-particle";
import { createDefaultParticleSettings, type ParticleSettings } from "../core/particle-settings";
import type { PluginParameter } from "../core/plugins";
import {
  findSceneGeneratorDefinition,
  getSceneGeneratorDefinitions,
  subscribeSceneGeneratorDefinitions,
} from "../core/scene-generator-registry";
import type {
  CameraSettings,
  Layer,
  LightSettings,
  Material3d,
  SceneGeneratorParameterValue,
} from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { ParticleControls } from "./ParticleControls";

export function Scene3dControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  useSyncExternalStore(
    subscribeSceneGeneratorDefinitions,
    getSceneGeneratorDefinitions,
    getSceneGeneratorDefinitions,
  );

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
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setSceneGenerator",
          layerId: layer.id,
          generator: createParticleSceneGenerator(particle),
        },
      ],
    });
  };

  const updateGeneratorParameter = (name: string, value: SceneGeneratorParameterValue) => {
    if (!layer.generator) return;
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setSceneGenerator",
          layerId: layer.id,
          generator: {
            ...layer.generator,
            parameters: { ...layer.generator.parameters, [name]: value },
          },
        },
      ],
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

  if (particleSettingsFromGenerator(layer.generator)) {
    return (
      <ParticleControls
        onChange={updateParticle}
        settings={particleSettingsFromGenerator(layer.generator) ?? createDefaultParticleSettings()}
      />
    );
  }

  if (layer.kind === "generator" && layer.generator) {
    const definition = findSceneGeneratorDefinition(
      layer.generator.pluginId,
      layer.generator.nodeType,
    );
    if (!definition)
      return (
        <div className="scene-generator-missing" role="status">
          <strong>{t("scene3d.generator.missing")}</strong>
          <small>
            {layer.generator.pluginId}:{layer.generator.nodeType}
          </small>
          <span>{t("scene3d.generator.missingHint")}</span>
        </div>
      );
    return (
      <div className="scene-generator-controls">
        <header>
          <strong>{definition.pluginName}</strong>
          <small>
            {definition.pluginId} · v{definition.pluginVersion}
          </small>
        </header>
        {definition.parameters.map((parameter) => (
          <GeneratorParameterControl
            key={parameter.name}
            onChange={(value) => updateGeneratorParameter(parameter.name, value)}
            parameter={parameter}
            value={layer.generator?.parameters[parameter.name]}
          />
        ))}
      </div>
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

function GeneratorParameterControl({
  onChange,
  parameter,
  value,
}: {
  onChange: (value: SceneGeneratorParameterValue) => void;
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
          value={typeof value === "number" ? value : parameter.default}
        />
      );
    case "choice":
      return (
        <label>
          {parameter.label}
          <select
            aria-label={parameter.label}
            onChange={(event) => onChange(event.target.value)}
            value={typeof value === "string" ? value : parameter.default}
          >
            {parameter.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
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
            <input
              aria-label={`${parameter.label} ${index + 1}`}
              key={`${parameter.name}-${channelName}`}
              max={maximum}
              min={minimum}
              onChange={(event) => {
                const next = [...channels];
                next[index] = Number(event.target.value);
                onChange(next);
              }}
              step={Math.max((maximum - minimum) / 100, 0.001)}
              type="number"
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
          <input disabled type="text" value="Host texture input" />
        </label>
      );
  }
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
