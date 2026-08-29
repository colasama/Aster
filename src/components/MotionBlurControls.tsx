import { Wind } from "lucide-react";
import { compositionMotionBlurSettings, layerSupportsMotionBlur } from "../core/motion-blur";
import type { Composition, Layer, MotionBlurSettings } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";

export function MotionBlurControls({
  composition,
  layer,
}: {
  composition: Composition;
  layer: Layer;
}) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  const settings = compositionMotionBlurSettings(composition);
  const update = (patch: Partial<MotionBlurSettings>) =>
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setCompositionMotionBlur",
          compositionId: composition.id,
          motionBlur: { ...settings, ...patch },
        },
      ],
    });
  const supportsLayer = layerSupportsMotionBlur(layer);
  return (
    <div className="inspector-section blend-section motion-blur-controls">
      <div className="section-title static">
        <Wind size={13} /> {t("inspector.motionBlur.title")}
      </div>
      <div className="compositing-grid">
        <label>
          {t("inspector.motionBlur.compositionEnabled")}
          <input
            checked={settings.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
            type="checkbox"
          />
        </label>
        <label>
          {t("inspector.motionBlur.layerEnabled")}
          <input
            checked={layer.motionBlur === true}
            disabled={!supportsLayer || layer.locked}
            onChange={() =>
              dispatch({
                type: "operation",
                operations: [{ type: "toggleLayer", layerId: layer.id, field: "motionBlur" }],
              })
            }
            title={!supportsLayer ? t("inspector.motionBlur.unsupported") : undefined}
            type="checkbox"
          />
        </label>
        <label>
          {t("inspector.motionBlur.shutterAngle")}
          <input
            max="720"
            min="0"
            onChange={(event) => update({ shutterAngle: Number(event.target.value) })}
            step="1"
            type="number"
            value={settings.shutterAngle}
          />
        </label>
        <label>
          {t("inspector.motionBlur.shutterPhase")}
          <input
            max="720"
            min="-720"
            onChange={(event) => update({ shutterPhase: Number(event.target.value) })}
            step="1"
            type="number"
            value={settings.shutterPhase}
          />
        </label>
        <label>
          {t("inspector.motionBlur.samples")}
          <input
            max="64"
            min="2"
            onChange={(event) => update({ samplesPerFrame: Number(event.target.value) })}
            step="1"
            type="number"
            value={settings.samplesPerFrame}
          />
        </label>
        <label>
          {t("inspector.motionBlur.adaptiveLimit")}
          <input
            max="128"
            min={settings.samplesPerFrame}
            onChange={(event) => update({ adaptiveSampleLimit: Number(event.target.value) })}
            step="1"
            type="number"
            value={settings.adaptiveSampleLimit}
          />
        </label>
      </div>
    </div>
  );
}
