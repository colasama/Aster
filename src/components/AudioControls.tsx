import {
  MAX_AUDIO_LEVEL_DB,
  MAX_AUDIO_PAN,
  MIN_AUDIO_LEVEL_DB,
  MIN_AUDIO_PAN,
} from "../core/audio-layer";
import type { AudioLayerSettings, Layer } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";

const DEFAULT_AUDIO: AudioLayerSettings = {
  levelsDb: [0, 0],
  pan: 0,
  muted: false,
  reversed: false,
};

export function AudioControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  if (layer.kind !== "video" && layer.kind !== "audio") return null;
  const audio = layer.audio ?? DEFAULT_AUDIO;
  const update = (next: Partial<AudioLayerSettings>) =>
    dispatch({
      type: "operation",
      operations: [
        { type: "setLayerAudioSettings", layerId: layer.id, audio: { ...audio, ...next } },
      ],
    });
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
        {t("audio.enabled")}
      </label>
      <label className="compositing-check">
        <input
          checked={audio.muted}
          onChange={(event) => update({ muted: event.target.checked })}
          type="checkbox"
        />
        {t("audio.mute")}
      </label>
      <label className="compositing-check">
        <input
          checked={audio.reversed}
          onChange={(event) => update({ reversed: event.target.checked })}
          type="checkbox"
        />
        {t("audio.reverse")}
      </label>
      {([0, 1] as const).map((channel) => (
        <label key={channel}>
          {channel === 0 ? t("audio.levelLeft") : t("audio.levelRight")}
          <input
            aria-label={channel === 0 ? t("audio.levelLeft") : t("audio.levelRight")}
            max={MAX_AUDIO_LEVEL_DB}
            min={MIN_AUDIO_LEVEL_DB}
            onChange={(event) => {
              const levelsDb: [number, number] = [...audio.levelsDb];
              levelsDb[channel] = Number(event.target.value);
              update({ levelsDb });
            }}
            step="0.1"
            type="number"
            value={audio.levelsDb[channel]}
          />
          <span>dB</span>
        </label>
      ))}
      <label>
        {t("audio.pan")}
        <input
          aria-label={t("audio.pan")}
          max={MAX_AUDIO_PAN}
          min={MIN_AUDIO_PAN}
          onChange={(event) => update({ pan: Number(event.target.value) })}
          step="0.01"
          type="range"
          value={audio.pan}
        />
        <span>{Math.round(audio.pan * 100)}</span>
      </label>
    </>
  );
}
