import { useSyncExternalStore } from "react";
import {
  createParticleSceneGenerator,
  particleSettingsFromGenerator,
} from "../core/bundled-particle";
import type { CameraAnimatableField } from "../core/camera-properties";
import { setCameraPropertyAtTime } from "../core/camera-properties";
import {
  createDefaultCameraSettings,
  evaluateCameraSettings,
  setDerivedCameraPropertyAtTime,
} from "../core/camera-settings";
import type { PropertyPath } from "../core/operations";
import { createDefaultParticleSettings, type ParticleSettings } from "../core/particle-settings";
import type { PluginParameter } from "../core/plugins";
import { propertyValueOperationAtTime } from "../core/property-edit-operation";
import {
  findSceneGeneratorDefinition,
  getSceneGeneratorDefinitions,
  subscribeSceneGeneratorDefinitions,
} from "../core/scene-generator-registry";
import { evaluateAnimatable, evaluateTransform } from "../core/timeline";
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
  const { dispatch, state } = useEditor();
  const { t } = useI18n();
  const composition =
    state.project.compositions.find(
      (candidate) => candidate.id === state.project.activeCompositionId,
    ) ?? state.project.compositions[0];
  const camera =
    layer.camera ??
    createDefaultCameraSettings(composition?.width ?? 1920, composition?.height ?? 1080);
  const evaluatedCamera = evaluateCameraSettings(
    camera,
    evaluateTransform(layer.transform, state.currentTime),
    state.currentTime,
    composition?.width ?? 1920,
  );
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

  const updateCamera = <Field extends keyof CameraSettings>(
    field: Field,
    value: CameraSettings[Field],
  ) => {
    const next: CameraSettings = { ...camera, [field]: value };
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setCameraSettings",
          layerId: layer.id,
          camera: next,
        },
      ],
    });
  };

  const updateCameraTrack = (field: CameraAnimatableField, value: number) => {
    const next = setCameraPropertyAtTime(camera, field, state.currentTime, value);
    if (field === "focusDistance" || field === "zoom") next.lockFocusToZoom = false;
    dispatch({
      type: "operation",
      operations: [{ type: "setCameraSettings", layerId: layer.id, camera: next }],
    });
  };

  const updateDerivedCamera = (field: "focalLength" | "fStop", value: number) => {
    const next = setDerivedCameraPropertyAtTime(
      camera,
      field,
      value,
      state.currentTime,
      composition?.width ?? 1920,
    );
    dispatch({
      type: "operation",
      operations: [{ type: "setCameraSettings", layerId: layer.id, camera: next }],
    });
  };

  const updateCameraProperty = (path: PropertyPath, value: number) => {
    dispatch({
      type: "operation",
      operations: [propertyValueOperationAtTime(layer, path, value, state.currentTime)],
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
    const projection = camera.projection;
    return (
      <>
        <label>
          {t("scene3d.camera.type")}
          <select
            aria-label={t("scene3d.camera.type")}
            onChange={(event) =>
              updateCamera("mode", event.target.value === "oneNode" ? "oneNode" : "twoNode")
            }
            value={camera.mode}
          >
            <option value="oneNode">{t("scene3d.camera.oneNode")}</option>
            <option value="twoNode">{t("scene3d.camera.twoNode")}</option>
          </select>
        </label>
        {camera.mode === "twoNode" && (
          <CameraVectorControl
            label={t("scene3d.camera.pointOfInterest")}
            onChange={updateCameraProperty}
            paths={[
              "camera.pointOfInterest.0",
              "camera.pointOfInterest.1",
              "camera.pointOfInterest.2",
            ]}
            properties={camera.pointOfInterest}
            time={state.currentTime}
            unit="px"
          />
        )}
        <CameraVectorControl
          label={t("scene3d.camera.orientation")}
          onChange={updateCameraProperty}
          paths={["camera.orientation.0", "camera.orientation.1", "camera.orientation.2"]}
          properties={camera.orientation}
          time={state.currentTime}
          unit="°"
        />
        <label>
          {t("scene3d.camera.projection")}
          <select
            aria-label={t("scene3d.camera.projectionA11y")}
            onChange={(event) =>
              updateCamera(
                "projection",
                event.target.value === "orthographic" ? "orthographic" : "perspective",
              )
            }
            value={projection}
          >
            <option value="perspective">{t("scene3d.camera.perspective")}</option>
            <option value="orthographic">{t("scene3d.camera.orthographic")}</option>
          </select>
        </label>
        {projection === "perspective" ? (
          <>
            <NumericControl
              label={t("scene3d.camera.zoom")}
              max={1_000_000}
              min={0.1}
              onChange={(value) => updateCameraTrack("zoom", value)}
              step={1}
              value={evaluatedCamera.optics.zoom}
            />
            <NumericControl
              label={t("scene3d.camera.focalLength")}
              max={10_000}
              min={0.1}
              onChange={(value) => updateDerivedCamera("focalLength", value)}
              step={0.1}
              value={evaluatedCamera.optics.focalLength}
            />
            <NumericControl
              label={t("scene3d.camera.filmSize")}
              max={1_000}
              min={0.1}
              onChange={(value) => updateCameraTrack("filmSize", value)}
              step={0.1}
              value={evaluatedCamera.optics.filmSize}
            />
          </>
        ) : (
          <NumericControl
            label={t("scene3d.camera.orthographicSize")}
            max={100_000}
            min={1}
            onChange={(value) => updateCameraTrack("orthographicSize", value)}
            step={10}
            value={evaluatedCamera.optics.orthographicSize}
          />
        )}
        <BooleanControl
          checked={camera.depthOfField}
          label={t("scene3d.camera.depthOfField")}
          onChange={(value) => updateCamera("depthOfField", value)}
        />
        {camera.depthOfField && projection === "perspective" && (
          <>
            <BooleanControl
              checked={camera.lockFocusToZoom}
              label={t("scene3d.camera.lockFocusToZoom")}
              onChange={(value) => updateCamera("lockFocusToZoom", value)}
            />
            <NumericControl
              label={t("scene3d.camera.focusDistance")}
              max={10_000_000}
              min={0.1}
              onChange={(value) => updateCameraTrack("focusDistance", value)}
              step={1}
              value={evaluatedCamera.optics.focusDistance}
            />
            <NumericControl
              label={t("scene3d.camera.aperture")}
              max={10_000}
              min={0.001}
              onChange={(value) => updateCameraTrack("aperture", value)}
              step={0.1}
              value={evaluatedCamera.optics.aperture}
            />
            <NumericControl
              label={t("scene3d.camera.fStop")}
              max={1_000}
              min={0.1}
              onChange={(value) => updateDerivedCamera("fStop", value)}
              step={0.1}
              value={evaluatedCamera.optics.fStop}
            />
            <NumericControl
              label={t("scene3d.camera.blurLevel")}
              max={1_000}
              min={0}
              onChange={(value) => updateCameraTrack("blurLevel", value)}
              step={1}
              value={evaluatedCamera.optics.blurLevel}
            />
            <NumericControl
              label={t("scene3d.camera.focusAreaWidth")}
              max={10_000_000}
              min={0}
              onChange={(value) => updateCameraTrack("focusAreaWidth", value)}
              step={1}
              value={evaluatedCamera.optics.focusAreaWidth}
            />
            <NumericControl
              label={t("scene3d.camera.nearBlurLevel")}
              max={1_000}
              min={0}
              onChange={(value) => updateCameraTrack("nearBlurLevel", value)}
              step={1}
              value={evaluatedCamera.optics.nearBlurLevel}
            />
            <NumericControl
              label={t("scene3d.camera.farBlurLevel")}
              max={1_000}
              min={0}
              onChange={(value) => updateCameraTrack("farBlurLevel", value)}
              step={1}
              value={evaluatedCamera.optics.farBlurLevel}
            />
            <label>
              {t("scene3d.camera.irisShape")}
              <select
                aria-label={t("scene3d.camera.irisShape")}
                onChange={(event) =>
                  updateCamera("irisShape", event.target.value as CameraSettings["irisShape"])
                }
                value={camera.irisShape}
              >
                <option value="fastRectangle">{t("scene3d.camera.irisShape.fastRectangle")}</option>
                <option value="square">{t("scene3d.camera.irisShape.square")}</option>
                <option value="triangle">{t("scene3d.camera.irisShape.triangle")}</option>
                <option value="pentagon">{t("scene3d.camera.irisShape.pentagon")}</option>
                <option value="hexagon">{t("scene3d.camera.irisShape.hexagon")}</option>
                <option value="heptagon">{t("scene3d.camera.irisShape.heptagon")}</option>
                <option value="octagon">{t("scene3d.camera.irisShape.octagon")}</option>
                <option value="nonagon">{t("scene3d.camera.irisShape.nonagon")}</option>
                <option value="decagon">{t("scene3d.camera.irisShape.decagon")}</option>
                <option value="circle">{t("scene3d.camera.irisShape.circle")}</option>
              </select>
            </label>
            <NumericControl
              label={t("scene3d.camera.irisRotation")}
              max={360}
              min={-360}
              onChange={(value) => updateCameraTrack("irisRotation", value)}
              step={1}
              value={evaluatedCamera.optics.irisRotation}
            />
            <NumericControl
              label={t("scene3d.camera.irisRoundness")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("irisRoundness", value)}
              step={1}
              value={evaluatedCamera.optics.irisRoundness}
            />
            <NumericControl
              label={t("scene3d.camera.irisAspectRatio")}
              max={100}
              min={1}
              onChange={(value) => updateCameraTrack("irisAspectRatio", value)}
              step={1}
              value={evaluatedCamera.optics.irisAspectRatio}
            />
            <NumericControl
              label={t("scene3d.camera.irisDiffractionFringe")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("irisDiffractionFringe", value)}
              step={1}
              value={evaluatedCamera.optics.irisDiffractionFringe}
            />
            <NumericControl
              label={t("scene3d.camera.highlightGain")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("highlightGain", value)}
              step={1}
              value={evaluatedCamera.optics.highlightGain}
            />
            <NumericControl
              label={t("scene3d.camera.highlightThreshold")}
              max={1}
              min={0}
              onChange={(value) => updateCameraTrack("highlightThreshold", value)}
              step={0.01}
              value={evaluatedCamera.optics.highlightThreshold}
            />
            <NumericControl
              label={t("scene3d.camera.highlightSaturation")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("highlightSaturation", value)}
              step={1}
              value={evaluatedCamera.optics.highlightSaturation}
            />
            <NumericControl
              label={t("scene3d.camera.renderQuality")}
              max={100}
              min={1}
              onChange={(value) => updateCamera("renderQuality", value)}
              step={1}
              value={camera.renderQuality}
            />
          </>
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

function BooleanControl({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label>
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}

function CameraVectorControl({
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
  time: number;
  unit: string;
}) {
  return (
    <fieldset className="scene-generator-vector">
      <legend>{label}</legend>
      {properties.map((property, index) => (
        <label key={paths[index]}>
          {"XYZ"[index]}
          <input
            aria-label={`${label} ${"XYZ"[index]}`}
            onChange={(event) => onChange(paths[index], Number(event.target.value))}
            step={0.1}
            type="number"
            value={evaluateAnimatable(property, time)}
          />
          <span>{unit}</span>
        </label>
      ))}
    </fieldset>
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
