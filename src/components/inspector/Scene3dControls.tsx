import { useSyncExternalStore } from "react";
import { evaluateTransform } from "../../core/animation/timeline";
import type { PropertyPath } from "../../core/editing/operations";
import { propertyValueOperationAtTime } from "../../core/editing/property-edit-operation";
import {
  createParticleSceneGenerator,
  particleSettingsFromGenerator,
} from "../../core/scene/bundled-particle";
import type { CameraAnimatableField } from "../../core/scene/camera-properties";
import { setCameraPropertyAtTime } from "../../core/scene/camera-properties";
import {
  createDefaultCameraSettings,
  evaluateCameraSettings,
  setDerivedCameraPropertyAtTime,
} from "../../core/scene/camera-settings";
import {
  createDefaultParticleSettings,
  type ParticleSettings,
} from "../../core/scene/particle-settings";
import {
  findSceneGeneratorDefinition,
  getSceneGeneratorDefinitions,
  subscribeSceneGeneratorDefinitions,
} from "../../core/scene/scene-generator-registry";
import type {
  CameraSettings,
  Layer,
  LightSettings,
  Material3d,
  SceneGeneratorParameterValue,
} from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";
import { ParticleControls } from "./ParticleControls";
import {
  BooleanControl,
  CameraVectorControl,
  GeneratorParameterControl,
  NumericControl,
} from "./Scene3dPropertyInputs";
import type { SettingsRecipe } from "./settings-edit";

export function Scene3dControls({ layer }: { layer: Layer }) {
  const { dispatch, state } = useEditor();
  const { t } = useI18n();
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  const mixed = (read: (entry: Layer) => unknown) => valuesDiffer(layers.map(read));
  const composition =
    state.project.compositions.find(
      (candidate) => candidate.id === state.project.activeCompositionId,
    ) ?? state.project.compositions[0];
  const cameraFor = (entry: Layer) =>
    entry.camera ??
    createDefaultCameraSettings(composition?.width ?? 1920, composition?.height ?? 1080);
  const cameras = layers.map(cameraFor);
  const camera = cameraFor(layer);
  const evaluatedCameras = layers.map((entry) =>
    evaluateCameraSettings(
      cameraFor(entry),
      evaluateTransform(entry.transform, state.currentTime),
      state.currentTime,
      composition?.width ?? 1920,
    ),
  );
  const evaluatedCamera = evaluatedCameras[0];
  useSyncExternalStore(
    subscribeSceneGeneratorDefinitions,
    getSceneGeneratorDefinitions,
    getSceneGeneratorDefinitions,
  );

  const updateMaterial = (field: keyof Material3d, value: number | string) => {
    if (typeof value === "number" && !Number.isFinite(value)) return;
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setMaterial3d",
        layerId: entry.id,
        material: {
          metallic: entry.material?.metallic ?? 0.18,
          roughness: entry.material?.roughness ?? 0.42,
          emissive: entry.material?.emissive ?? 0,
          alphaMode: entry.material?.alphaMode ?? "opaque",
          alphaCutoff: entry.material?.alphaCutoff ?? 0.5,
          [field]: value,
        },
      })),
    });
  };

  const updateLight = (field: keyof LightSettings, value: string | number) => {
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setLightSettings",
        layerId: entry.id,
        light: {
          kind: entry.light?.kind ?? "directional",
          intensity: entry.light?.intensity ?? 2.5,
          range: entry.light?.range ?? 2400,
          coneAngle: entry.light?.coneAngle ?? 45,
          shadowQuality: entry.light?.shadowQuality ?? "medium",
          [field]: value,
        },
      })),
    });
  };

  const updateCamera = <Field extends keyof CameraSettings>(
    field: Field,
    value: CameraSettings[Field],
  ) =>
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setCameraSettings",
        layerId: entry.id,
        camera: { ...cameraFor(entry), [field]: value },
      })),
    });
  const updateCameraTrack = (field: CameraAnimatableField, value: number) =>
    dispatch({
      type: "operation",
      operations: editable.map((entry) => {
        const next = setCameraPropertyAtTime(cameraFor(entry), field, state.currentTime, value);
        if (field === "focusDistance" || field === "zoom") next.lockFocusToZoom = false;
        return { type: "setCameraSettings", layerId: entry.id, camera: next };
      }),
    });
  const updateDerivedCamera = (field: "focalLength" | "fStop", value: number) =>
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setCameraSettings",
        layerId: entry.id,
        camera: setDerivedCameraPropertyAtTime(
          cameraFor(entry),
          field,
          value,
          state.currentTime,
          composition?.width ?? 1920,
        ),
      })),
    });
  const updateCameraProperty = (path: PropertyPath, value: number) =>
    dispatch({
      type: "operation",
      operations: editable.map((entry) =>
        propertyValueOperationAtTime(entry, path, value, state.currentTime),
      ),
    });
  const updateParticle = (particle: ParticleSettings, recipe?: SettingsRecipe<ParticleSettings>) =>
    dispatch({
      type: "operation",
      operations: layers.flatMap((entry, index) =>
        entry.locked
          ? []
          : [
              {
                type: "setSceneGenerator" as const,
                layerId: entry.id,
                generator: createParticleSceneGenerator(
                  recipe
                    ? recipe(
                        particleSettingsFromGenerator(entry.generator) ??
                          createDefaultParticleSettings(),
                        index,
                      )
                    : particle,
                ),
              },
            ],
      ),
    });
  const updateGeneratorParameter = (
    name: string,
    value: SceneGeneratorParameterValue,
    recipe?: SettingsRecipe<SceneGeneratorParameterValue>,
    defaultValue?: SceneGeneratorParameterValue,
  ) =>
    dispatch({
      type: "operation",
      operations: layers.flatMap((entry, index) =>
        entry.locked || !entry.generator
          ? []
          : [
              {
                type: "setSceneGenerator" as const,
                layerId: entry.id,
                generator: {
                  ...entry.generator,
                  parameters: {
                    ...entry.generator.parameters,
                    [name]: recipe
                      ? recipe(entry.generator.parameters[name] ?? defaultValue ?? value, index)
                      : value,
                  },
                },
              },
            ],
      ),
    });

  if (layer.kind === "mesh") {
    return (
      <>
        <NumericControl
          label={t("scene3d.material.metallic")}
          max={1}
          min={0}
          onChange={(value) => updateMaterial("metallic", value)}
          step={0.01}
          mixed={mixed((entry) => entry.material?.metallic ?? 0.18)}
          value={layer.material?.metallic ?? 0.18}
        />
        <NumericControl
          label={t("scene3d.material.roughness")}
          max={1}
          min={0.04}
          onChange={(value) => updateMaterial("roughness", value)}
          step={0.01}
          mixed={mixed((entry) => entry.material?.roughness ?? 0.42)}
          value={layer.material?.roughness ?? 0.42}
        />
        <NumericControl
          label={t("scene3d.material.emissive")}
          max={16}
          min={0}
          onChange={(value) => updateMaterial("emissive", value)}
          step={0.05}
          mixed={mixed((entry) => entry.material?.emissive ?? 0)}
          value={layer.material?.emissive ?? 0}
        />
        <label>
          {t("scene3d.material.alphaMode")}
          <MixedValueSelect
            aria-label={t("scene3d.material.alphaMode")}
            onChange={(event) => updateMaterial("alphaMode", event.target.value)}
            mixed={mixed((entry) => entry.material?.alphaMode ?? "opaque")}
            value={layer.material?.alphaMode ?? "opaque"}
          >
            <option value="opaque">{t("scene3d.alpha.opaque")}</option>
            <option value="mask">{t("scene3d.alpha.mask")}</option>
            <option value="blend">{t("scene3d.alpha.blend")}</option>
          </MixedValueSelect>
        </label>
        {layers.every((entry) => entry.material?.alphaMode === "mask") && (
          <NumericControl
            label={t("scene3d.material.alphaCutoff")}
            max={1}
            min={0}
            onChange={(value) => updateMaterial("alphaCutoff", value)}
            step={0.01}
            mixed={mixed((entry) => entry.material?.alphaCutoff ?? 0.5)}
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
          <MixedValueSelect
            aria-label={t("scene3d.camera.type")}
            onChange={(event) =>
              updateCamera("mode", event.target.value === "oneNode" ? "oneNode" : "twoNode")
            }
            mixed={valuesDiffer(cameras.map((entry) => entry.mode))}
            value={camera.mode}
          >
            <option value="oneNode">{t("scene3d.camera.oneNode")}</option>
            <option value="twoNode">{t("scene3d.camera.twoNode")}</option>
          </MixedValueSelect>
        </label>
        {cameras.every((entry) => entry.mode === "twoNode") && (
          <CameraVectorControl
            label={t("scene3d.camera.pointOfInterest")}
            onChange={updateCameraProperty}
            paths={[
              "camera.pointOfInterest.0",
              "camera.pointOfInterest.1",
              "camera.pointOfInterest.2",
            ]}
            selections={cameras.map((entry) => entry.pointOfInterest)}
            properties={camera.pointOfInterest}
            time={state.currentTime}
            unit="px"
          />
        )}
        <CameraVectorControl
          label={t("scene3d.camera.orientation")}
          onChange={updateCameraProperty}
          paths={["camera.orientation.0", "camera.orientation.1", "camera.orientation.2"]}
          selections={cameras.map((entry) => entry.orientation)}
          properties={camera.orientation}
          time={state.currentTime}
          unit="°"
        />
        <label>
          {t("scene3d.camera.projection")}
          <MixedValueSelect
            aria-label={t("scene3d.camera.projectionA11y")}
            onChange={(event) =>
              updateCamera(
                "projection",
                event.target.value === "orthographic" ? "orthographic" : "perspective",
              )
            }
            mixed={valuesDiffer(cameras.map((entry) => entry.projection))}
            value={projection}
          >
            <option value="perspective">{t("scene3d.camera.perspective")}</option>
            <option value="orthographic">{t("scene3d.camera.orthographic")}</option>
          </MixedValueSelect>
        </label>
        {cameras.every((entry) => entry.projection === "perspective") ? (
          <>
            <NumericControl
              label={t("scene3d.camera.zoom")}
              max={1_000_000}
              min={0.1}
              onChange={(value) => updateCameraTrack("zoom", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.zoom))}
              value={evaluatedCamera.optics.zoom}
            />
            <NumericControl
              label={t("scene3d.camera.focalLength")}
              max={10_000}
              min={0.1}
              onChange={(value) => updateDerivedCamera("focalLength", value)}
              step={0.1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.focalLength))}
              value={evaluatedCamera.optics.focalLength}
            />
            <NumericControl
              label={t("scene3d.camera.filmSize")}
              max={1_000}
              min={0.1}
              onChange={(value) => updateCameraTrack("filmSize", value)}
              step={0.1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.filmSize))}
              value={evaluatedCamera.optics.filmSize}
            />
          </>
        ) : cameras.every((entry) => entry.projection === "orthographic") ? (
          <NumericControl
            label={t("scene3d.camera.orthographicSize")}
            max={10_000_000}
            min={1}
            onChange={(value) => updateCameraTrack("orthographicSize", value)}
            step={10}
            mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.orthographicSize))}
            value={evaluatedCamera.optics.orthographicSize}
          />
        ) : null}
        <BooleanControl
          mixed={valuesDiffer(cameras.map((entry) => entry.depthOfField))}
          checked={camera.depthOfField}
          label={t("scene3d.camera.depthOfField")}
          onChange={(value) => updateCamera("depthOfField", value)}
        />
        {cameras.every((entry) => entry.depthOfField && entry.projection === "perspective") && (
          <>
            <BooleanControl
              mixed={valuesDiffer(cameras.map((entry) => entry.lockFocusToZoom))}
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
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.focusDistance))}
              value={evaluatedCamera.optics.focusDistance}
            />
            <NumericControl
              label={t("scene3d.camera.aperture")}
              max={10_000}
              min={0.001}
              onChange={(value) => updateCameraTrack("aperture", value)}
              step={0.1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.aperture))}
              value={evaluatedCamera.optics.aperture}
            />
            <NumericControl
              label={t("scene3d.camera.fStop")}
              max={1_000}
              min={0.1}
              onChange={(value) => updateDerivedCamera("fStop", value)}
              step={0.1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.fStop))}
              value={evaluatedCamera.optics.fStop}
            />
            <NumericControl
              label={t("scene3d.camera.blurLevel")}
              max={1_000}
              min={0}
              onChange={(value) => updateCameraTrack("blurLevel", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.blurLevel))}
              value={evaluatedCamera.optics.blurLevel}
            />
            <NumericControl
              label={t("scene3d.camera.focusAreaWidth")}
              max={10_000_000}
              min={0}
              onChange={(value) => updateCameraTrack("focusAreaWidth", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.focusAreaWidth))}
              value={evaluatedCamera.optics.focusAreaWidth}
            />
            <NumericControl
              label={t("scene3d.camera.nearBlurLevel")}
              max={1_000}
              min={0}
              onChange={(value) => updateCameraTrack("nearBlurLevel", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.nearBlurLevel))}
              value={evaluatedCamera.optics.nearBlurLevel}
            />
            <NumericControl
              label={t("scene3d.camera.farBlurLevel")}
              max={1_000}
              min={0}
              onChange={(value) => updateCameraTrack("farBlurLevel", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.farBlurLevel))}
              value={evaluatedCamera.optics.farBlurLevel}
            />
            <label>
              {t("scene3d.camera.irisShape")}
              <MixedValueSelect
                aria-label={t("scene3d.camera.irisShape")}
                onChange={(event) =>
                  updateCamera("irisShape", event.target.value as CameraSettings["irisShape"])
                }
                mixed={valuesDiffer(cameras.map((entry) => entry.irisShape))}
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
              </MixedValueSelect>
            </label>
            <NumericControl
              label={t("scene3d.camera.irisRotation")}
              max={360}
              min={-360}
              onChange={(value) => updateCameraTrack("irisRotation", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.irisRotation))}
              value={evaluatedCamera.optics.irisRotation}
            />
            <NumericControl
              label={t("scene3d.camera.irisRoundness")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("irisRoundness", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.irisRoundness))}
              value={evaluatedCamera.optics.irisRoundness}
            />
            <NumericControl
              label={t("scene3d.camera.irisAspectRatio")}
              max={100}
              min={1}
              onChange={(value) => updateCameraTrack("irisAspectRatio", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.irisAspectRatio))}
              value={evaluatedCamera.optics.irisAspectRatio}
            />
            <NumericControl
              label={t("scene3d.camera.irisDiffractionFringe")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("irisDiffractionFringe", value)}
              step={1}
              mixed={valuesDiffer(
                evaluatedCameras.map((entry) => entry.optics.irisDiffractionFringe),
              )}
              value={evaluatedCamera.optics.irisDiffractionFringe}
            />
            <NumericControl
              label={t("scene3d.camera.highlightGain")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("highlightGain", value)}
              step={1}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.highlightGain))}
              value={evaluatedCamera.optics.highlightGain}
            />
            <NumericControl
              label={t("scene3d.camera.highlightThreshold")}
              max={1}
              min={0}
              onChange={(value) => updateCameraTrack("highlightThreshold", value)}
              step={0.01}
              mixed={valuesDiffer(evaluatedCameras.map((entry) => entry.optics.highlightThreshold))}
              value={evaluatedCamera.optics.highlightThreshold}
            />
            <NumericControl
              label={t("scene3d.camera.highlightSaturation")}
              max={100}
              min={0}
              onChange={(value) => updateCameraTrack("highlightSaturation", value)}
              step={1}
              mixed={valuesDiffer(
                evaluatedCameras.map((entry) => entry.optics.highlightSaturation),
              )}
              value={evaluatedCamera.optics.highlightSaturation}
            />
            <NumericControl
              label={t("scene3d.camera.renderQuality")}
              max={100}
              min={1}
              onChange={(value) => updateCamera("renderQuality", value)}
              step={1}
              mixed={valuesDiffer(cameras.map((entry) => entry.renderQuality))}
              value={camera.renderQuality}
            />
          </>
        )}
      </>
    );
  }

  if (
    layer.kind === "generator" &&
    !layers.every(
      (entry) =>
        entry.generator?.pluginId === layer.generator?.pluginId &&
        entry.generator?.nodeType === layer.generator?.nodeType,
    )
  )
    return null;
  if (particleSettingsFromGenerator(layer.generator)) {
    return (
      <ParticleControls
        onChange={updateParticle}
        selection={layers.map(
          (entry) =>
            particleSettingsFromGenerator(entry.generator) ?? createDefaultParticleSettings(),
        )}
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
            onChange={(value, recipe) =>
              updateGeneratorParameter(
                parameter.name,
                value,
                recipe,
                parameter.type === "texture" ? undefined : parameter.default,
              )
            }
            selection={layers.map((entry) => entry.generator?.parameters[parameter.name])}
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
        <MixedValueSelect
          aria-label={t("scene3d.light.type")}
          onChange={(event) => updateLight("kind", event.target.value)}
          mixed={mixed((entry) => entry.light?.kind ?? "directional")}
          value={lightKind}
        >
          <option value="directional">{t("scene3d.light.directional")}</option>
          <option value="point">{t("scene3d.light.point")}</option>
          <option value="spot">{t("scene3d.light.spot")}</option>
        </MixedValueSelect>
      </label>
      <NumericControl
        label={t("scene3d.light.intensity")}
        max={100}
        min={0}
        onChange={(value) => updateLight("intensity", value)}
        step={0.1}
        mixed={mixed((entry) => entry.light?.intensity ?? 2.5)}
        value={layer.light?.intensity ?? 2.5}
      />
      {layers.every((entry) => entry.light?.kind === "point" || entry.light?.kind === "spot") && (
        <NumericControl
          label={t("scene3d.light.range")}
          max={20_000}
          min={1}
          onChange={(value) => updateLight("range", value)}
          step={10}
          mixed={mixed((entry) => entry.light?.range ?? 2400)}
          value={layer.light?.range ?? 2400}
        />
      )}
      {layers.every((entry) => entry.light?.kind === "spot") && (
        <NumericControl
          label={t("scene3d.light.coneAngle")}
          max={179}
          min={1}
          onChange={(value) => updateLight("coneAngle", value)}
          step={1}
          mixed={mixed((entry) => entry.light?.coneAngle ?? 45)}
          value={layer.light?.coneAngle ?? 45}
        />
      )}
      <label>
        {t("scene3d.light.shadowQuality")}
        <MixedValueSelect
          aria-label={t("scene3d.light.shadowQuality")}
          onChange={(event) => updateLight("shadowQuality", event.target.value)}
          mixed={mixed((entry) => entry.light?.shadowQuality ?? "medium")}
          value={layer.light?.shadowQuality ?? "medium"}
        >
          <option value="off">{t("scene3d.light.shadowOff")}</option>
          <option value="low">{t("scene3d.light.shadowLow")}</option>
          <option value="medium">{t("scene3d.light.shadowMedium")}</option>
          <option value="high">{t("scene3d.light.shadowHigh")}</option>
        </MixedValueSelect>
      </label>
      <label>
        {t("scene3d.light.color")}
        <MixedValueInput
          aria-label={t("scene3d.light.color")}
          onChange={(event) => {
            const color = Number.parseInt(event.target.value.slice(1), 16);
            dispatch({
              type: "operation",
              operations: editable.map((entry) => ({
                type: "setLayerColor",
                layerId: entry.id,
                color: [
                  ((color >> 16) & 0xff) / 255,
                  ((color >> 8) & 0xff) / 255,
                  (color & 0xff) / 255,
                  entry.color[3],
                ],
              })),
            });
          }}
          type="color"
          mixed={mixed((entry) => rgbColorInput(entry.color))}
          value={rgbColorInput(layer.color)}
        />
      </label>
    </>
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
