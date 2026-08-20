import { MAX_PREVIEW_AUDIO_GAIN, MIN_PREVIEW_AUDIO_GAIN } from "../core/audio-preview";
import type { Layer } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";

export function AudioControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  if (layer.kind !== "video") return null;
  const gain = layer.audioGain ?? 1;
  return (
    <>
      <label className="compositing-check">
        <input
          checked={layer.audioEnabled !== false}
          onChange={() =>
            dispatch({
              type: "operation",
              operations: [{ type: "toggleLayer", layerId: layer.id, field: "audioEnabled" }],
            })
          }
          type="checkbox"
        />
        {t("audio.preview")}
      </label>
      <label>
        {t("audio.gain")}
        <input
          aria-label={t("audio.gain")}
          max={MAX_PREVIEW_AUDIO_GAIN}
          min={MIN_PREVIEW_AUDIO_GAIN}
          onChange={(event) =>
            dispatch({
              type: "operation",
              operations: [
                { type: "setLayerAudioGain", layerId: layer.id, gain: Number(event.target.value) },
              ],
            })
          }
          step="0.01"
          type="range"
          value={gain}
        />
        <span>{Math.round(gain * 100)}%</span>
      </label>
    </>
  );
}
