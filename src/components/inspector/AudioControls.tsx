import {
  MAX_AUDIO_LEVEL_DB,
  MAX_AUDIO_PAN,
  MIN_AUDIO_LEVEL_DB,
  MIN_AUDIO_PAN,
} from "../../core/audio/audio-layer";
import type { Operation } from "../../core/editing/operations";
import { sourceSupportsLayer } from "../../core/media/footage-source";
import { activeComposition } from "../../core/project/project";
import type { AudioLayerSettings, FootageSource, Layer } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";

const DEFAULT_AUDIO: AudioLayerSettings = {
  levelsDb: [0, 0],
  pan: 0,
  muted: false,
  reversed: false,
};

export function AudioControls({ layer }: { layer: Layer }) {
  const { dispatch, state } = useEditor();
  const { t } = useI18n();
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  const selection = layers.map((entry) => entry.audio ?? DEFAULT_AUDIO);
  if (layer.kind !== "video" && layer.kind !== "audio") return null;
  const audio = layer.audio ?? DEFAULT_AUDIO;
  const compatibleSources = state.project.sources.filter(
    (source): source is Extract<FootageSource, { kind: "audio" | "video" }> =>
      layers.every((entry) => sourceSupportsLayer(source, entry)),
  );
  const update = (
    next:
      | Partial<AudioLayerSettings>
      | ((audio: AudioLayerSettings) => Partial<AudioLayerSettings>),
  ) =>
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setLayerAudioSettings",
        layerId: entry.id,
        audio: {
          ...(entry.audio ?? DEFAULT_AUDIO),
          ...(typeof next === "function" ? next(entry.audio ?? DEFAULT_AUDIO) : next),
        },
      })),
    });
  return (
    <>
      {layers.every((entry) => entry.kind === "audio") && (
        <label>
          {t("audio.source")}
          <MixedValueSelect
            aria-label={t("audio.source")}
            onChange={(event) => {
              const source = compatibleSources.find(
                (candidate) => candidate.id === event.target.value,
              );
              const operations = editable.flatMap((entry): Operation[] => {
                const result: Operation[] = [
                  {
                    type: "setLayerSource",
                    layerId: entry.id,
                    ...(source ? { sourceId: source.id } : {}),
                  },
                ];
                if (source && !entry.sourceId) {
                  const composition = activeComposition(state.project);
                  result.push({
                    type: "setLayerTiming",
                    layerId: entry.id,
                    inPoint: entry.inPoint,
                    outPoint: Math.min(composition.duration, entry.inPoint + source.duration),
                  });
                  if (entry.name === "Audio Layer")
                    result.push({
                      type: "renameLayer",
                      layerId: entry.id,
                      name: source.name.replace(/\.[^.]+$/, "") || source.name,
                    });
                }
                return result;
              });
              dispatch({ type: "operation", operations });
            }}
            mixed={valuesDiffer(layers.map((entry) => entry.sourceId ?? ""))}
            value={layer.sourceId ?? ""}
          >
            <option value="">{t("audio.noSource")}</option>
            {compatibleSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </MixedValueSelect>
        </label>
      )}
      <label className="compositing-check">
        <MixedValueInput
          mixed={valuesDiffer(layers.map((entry) => entry.audioEnabled !== false))}
          checked={layer.audioEnabled !== false}
          onChange={(event) =>
            dispatch({
              type: "operation",
              operations: editable
                .filter((entry) => (entry.audioEnabled !== false) !== event.target.checked)
                .map((entry) => ({
                  type: "toggleLayer",
                  layerId: entry.id,
                  field: "audioEnabled",
                })),
            })
          }
          type="checkbox"
        />
        {t("audio.enabled")}
      </label>
      <label className="compositing-check">
        <MixedValueInput
          mixed={valuesDiffer(selection.map((entry) => entry.muted))}
          checked={audio.muted}
          onChange={(event) => update({ muted: event.target.checked })}
          type="checkbox"
        />
        {t("audio.mute")}
      </label>
      <label className="compositing-check">
        <MixedValueInput
          mixed={valuesDiffer(selection.map((entry) => entry.reversed))}
          checked={audio.reversed}
          onChange={(event) => update({ reversed: event.target.checked })}
          type="checkbox"
        />
        {t("audio.reverse")}
      </label>
      {([0, 1] as const).map((channel) => (
        <label key={channel}>
          {channel === 0 ? t("audio.levelLeft") : t("audio.levelRight")}
          <MixedValueInput
            aria-label={channel === 0 ? t("audio.levelLeft") : t("audio.levelRight")}
            max={MAX_AUDIO_LEVEL_DB}
            min={MIN_AUDIO_LEVEL_DB}
            onChange={(event) =>
              update((current) => {
                const levelsDb: [number, number] = [...current.levelsDb];
                levelsDb[channel] = Number(event.target.value);
                return { levelsDb };
              })
            }
            step="0.1"
            type="number"
            mixed={valuesDiffer(selection.map((entry) => entry.levelsDb[channel]))}
            value={audio.levelsDb[channel]}
          />
          <span>dB</span>
        </label>
      ))}
      <label>
        {t("audio.pan")}
        <MixedValueInput
          aria-label={t("audio.pan")}
          max={MAX_AUDIO_PAN}
          min={MIN_AUDIO_PAN}
          onChange={(event) => update({ pan: Number(event.target.value) })}
          step="0.01"
          type="range"
          mixed={valuesDiffer(selection.map((entry) => entry.pan))}
          value={audio.pan}
        />
        <span>
          {valuesDiffer(selection.map((entry) => entry.pan)) ? "—" : Math.round(audio.pan * 100)}
        </span>
      </label>
    </>
  );
}
