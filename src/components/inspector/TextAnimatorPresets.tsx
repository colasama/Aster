import { Download, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  BUILT_IN_TEXT_PRESETS,
  canAppendPresetGroups,
  createTextAnimatorPreset,
  exportTextAnimatorPreset,
  importTextAnimatorPreset,
  instantiateTextAnimatorPreset,
  loadUserTextPresets,
  persistUserTextPresets,
  type TextAnimatorPreset,
} from "../../core/animation/text-animator-presets";
import {
  MAX_TEXT_ANIMATOR_GROUPS,
  type TextAnimatorStackSettings,
} from "../../core/animation/text-animator-stack";
import { useI18n } from "../../i18n/react";
import type { SettingsEdit } from "./settings-edit";

export function TextAnimatorPresets({
  onChange,
  settings,
  times,
  time,
}: {
  onChange: SettingsEdit<TextAnimatorStackSettings>;
  settings: TextAnimatorStackSettings;
  times?: readonly number[];
  time: number;
}) {
  const { t } = useI18n();
  const [userPresets, setUserPresets] = useState<TextAnimatorPreset[]>(() => loadUserTextPresets());
  const [selectedId, setSelectedId] = useState(BUILT_IN_TEXT_PRESETS[0]?.id ?? "");
  const [presetName, setPresetName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const presets = [...BUILT_IN_TEXT_PRESETS, ...userPresets];
  const selected = presets.find((preset) => preset.id === selectedId);
  const canApply =
    selected !== undefined &&
    canAppendPresetGroups(selected.groups, settings.groups) &&
    selected.groups.length > 0;
  const canSave = settings.groups.length > 0;

  const commitUserPresets = (next: TextAnimatorPreset[]) => {
    setUserPresets(next);
    persistUserTextPresets(next);
  };

  const apply = () => {
    if (!selected || !canApply) return;
    onChange(settings, (current, index) => {
      const room = Math.max(0, MAX_TEXT_ANIMATOR_GROUPS - current.groups.length);
      const groups = instantiateTextAnimatorPreset(selected, times?.[index] ?? time).slice(0, room);
      if (groups.length === 0) return current;
      return { ...current, enabled: true, groups: [...current.groups, ...groups] };
    });
  };

  const save = () => {
    if (!canSave) return;
    const preset = createTextAnimatorPreset(
      presetName || selected?.name || "Preset",
      settings.groups,
    );
    commitUserPresets([...userPresets, preset]);
    setSelectedId(preset.id);
    setPresetName("");
  };

  const rename = () => {
    if (!selected || selected.builtIn || !presetName.trim()) return;
    commitUserPresets(
      userPresets.map((entry) =>
        entry.id === selected.id ? { ...entry, name: presetName.trim() } : entry,
      ),
    );
  };

  const remove = () => {
    if (!selected || selected.builtIn) return;
    commitUserPresets(userPresets.filter((entry) => entry.id !== selected.id));
    setSelectedId(BUILT_IN_TEXT_PRESETS[0]?.id ?? "");
  };

  const exportPreset = () => {
    if (!selected) return;
    const blob = new Blob([exportTextAnimatorPreset(selected)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.name.replace(/[^\w-]+/gu, "_")}.aster-textpreset.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importPreset = async (file: File | undefined) => {
    if (!file) return;
    const preset = importTextAnimatorPreset(await file.text());
    if (!preset) return;
    commitUserPresets([...userPresets, preset]);
    setSelectedId(preset.id);
  };

  return (
    <section className="text-animator-presets" aria-label={t("text.presets")}>
      <div className="text-animator-subheading">{t("text.presets")}</div>
      <div className="text-stack-add-row">
        <select
          aria-label={t("text.presets.select")}
          onChange={(event) => setSelectedId(event.target.value)}
          value={selectedId}
        >
          {(["entrance", "emphasis", "layout"] as const).map((category) => (
            <optgroup key={category} label={t(`text.presets.category.${category}`)}>
              {BUILT_IN_TEXT_PRESETS.filter((preset) => preset.category === category).map(
                (preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ),
              )}
            </optgroup>
          ))}
          {userPresets.length > 0 && (
            <optgroup label={t("text.presets.user")}>
              {userPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button disabled={!canApply} onClick={apply} type="button">
          {t("text.presets.apply")}
        </button>
      </div>
      <div className="text-stack-add-row">
        <input
          aria-label={t("text.presets.name")}
          maxLength={128}
          onChange={(event) => setPresetName(event.target.value)}
          placeholder={t("text.presets.name")}
          type="text"
          value={presetName}
        />
        <button disabled={!canSave} onClick={save} type="button">
          {t("text.presets.save")}
        </button>
        <button
          aria-label={t("text.presets.rename")}
          disabled={!selected || selected.builtIn || !presetName.trim()}
          onClick={rename}
          title={t("text.presets.rename")}
          type="button"
        >
          {t("text.presets.rename")}
        </button>
        <button
          aria-label={t("text.presets.delete")}
          disabled={!selected || selected.builtIn}
          onClick={remove}
          title={t("text.presets.delete")}
          type="button"
        >
          <Trash2 aria-hidden="true" size={11} />
        </button>
        <button
          aria-label={t("text.presets.export")}
          disabled={!selected}
          onClick={exportPreset}
          title={t("text.presets.export")}
          type="button"
        >
          <Download aria-hidden="true" size={11} />
        </button>
        <button
          aria-label={t("text.presets.import")}
          onClick={() => fileInput.current?.click()}
          title={t("text.presets.import")}
          type="button"
        >
          <Upload aria-hidden="true" size={11} />
        </button>
        <input
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            void importPreset(event.target.files?.[0]);
            event.target.value = "";
          }}
          ref={fileInput}
          type="file"
        />
      </div>
    </section>
  );
}
