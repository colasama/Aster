import { ChevronDown, Clock3, Save, Sparkles, Star, Trash2 } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { activeComposition } from "../../core/project/project";
import {
  readEffectBrowserPreferences,
  recordRecentEffect,
  toggleFavoriteEffect,
  writeEffectBrowserPreferences,
} from "../../effects/browser/browser-preferences";
import {
  getPluginEffectDefinitions,
  subscribePluginEffectDefinitions,
} from "../../effects/plugin-registry";
import { createEffectsFromPreset, LOOK_PRESETS } from "../../effects/presets/presets";
import {
  addUserEffectPreset,
  createEffectsFromUserPreset,
  createUserEffectPreset,
  readUserEffectPresets,
  removeUserEffectPreset,
  writeUserEffectPresets,
} from "../../effects/presets/user-presets";
import {
  createEffect,
  EFFECT_BY_TYPE,
  EFFECT_REGISTRY,
  effectCategories,
} from "../../effects/registry";
import type { EffectDefinition } from "../../effects/types";
import { reportUiError } from "../../errors/report-ui-error";
import { type UiErrorCode, uiErrorMessage } from "../../i18n/errors";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";

export function EffectBrowser({ query, hidden }: { query: string; hidden: boolean }) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
  const [presetError, setPresetError] = useState<UiErrorCode>();
  const [presetName, setPresetName] = useState("");
  const [effectPreferences, setEffectPreferences] = useState(() =>
    readEffectBrowserPreferences(localPreferenceStorage()),
  );
  const [userPresets, setUserPresets] = useState(() =>
    readUserEffectPresets(localPreferenceStorage()),
  );
  const pluginEffects = useSyncExternalStore(
    subscribePluginEffectDefinitions,
    getPluginEffectDefinitions,
    getPluginEffectDefinitions,
  );
  const availableEffects = useMemo(() => [...EFFECT_REGISTRY, ...pluginEffects], [pluginEffects]);
  const filteredEffects = useMemo(
    () =>
      availableEffects.filter((effect) =>
        `${effect.name} ${effect.category} ${effect.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [availableEffects, query],
  );
  const filteredPresets = useMemo(
    () =>
      LOOK_PRESETS.filter((preset) =>
        `${preset.name} ${preset.description}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );
  const filteredUserPresets = useMemo(
    () =>
      userPresets.filter((preset) =>
        `${preset.name} ${preset.effects.map((effect) => effect.type).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [query, userPresets],
  );
  const filteredEffectTypes = useMemo(
    () => new Set(filteredEffects.map((effect) => effect.type)),
    [filteredEffects],
  );
  const favoriteEffects = useMemo(
    () =>
      effectPreferences.favorites
        .map((type) => EFFECT_BY_TYPE.get(type))
        .filter(
          (effect): effect is EffectDefinition =>
            effect !== undefined && filteredEffectTypes.has(effect.type),
        ),
    [effectPreferences.favorites, filteredEffectTypes],
  );
  const recentEffects = useMemo(
    () =>
      effectPreferences.recent
        .map((type) => EFFECT_BY_TYPE.get(type))
        .filter(
          (effect): effect is EffectDefinition =>
            effect !== undefined && filteredEffectTypes.has(effect.type),
        ),
    [effectPreferences.recent, filteredEffectTypes],
  );
  useEffect(() => {
    writeEffectBrowserPreferences(localPreferenceStorage(), effectPreferences);
  }, [effectPreferences]);
  useEffect(() => {
    writeUserEffectPresets(localPreferenceStorage(), userPresets);
  }, [userPresets]);
  const applyEffect = (type: string) => {
    const layerId = state.selection[0];
    if (!layerId) return;
    dispatch({
      type: "operation",
      operations: [{ type: "addEffect", layerId, effect: createEffect(type) }],
    });
    setEffectPreferences((preferences) => recordRecentEffect(preferences, type));
  };
  const applyPreset = (presetId: string) => {
    const layerId = state.selection[0];
    const preset = LOOK_PRESETS.find((candidate) => candidate.id === presetId);
    if (!layerId || !preset) return;
    dispatch({
      type: "operation",
      operations: createEffectsFromPreset(preset).map((effect) => ({
        type: "addEffect" as const,
        layerId,
        effect,
      })),
    });
  };
  const applyUserPreset = (presetId: string) => {
    const layerId = state.selection[0];
    const preset = userPresets.find((candidate) => candidate.id === presetId);
    if (!layerId || !preset) return;
    dispatch({
      type: "operation",
      operations: createEffectsFromUserPreset(preset).map((effect) => ({
        type: "addEffect" as const,
        layerId,
        effect,
      })),
    });
  };
  const saveUserPreset = () => {
    if (!selectedLayer) return;
    try {
      const preset = createUserEffectPreset(presetName, selectedLayer.effects);
      setUserPresets((current) => addUserEffectPreset(current, preset));
      setPresetName("");
      setPresetError(undefined);
    } catch (error) {
      setPresetError("presetSave");
      reportUiError(t, "presetSave", error, {
        scope: {
          area: "layer",
          projectId: state.project.id,
          compositionId: composition.id,
          layerId: selectedLayer.id,
        },
      });
    }
  };
  if (hidden) return null;
  return (
    <div className="effect-list">
      <div className="user-preset-save">
        <input
          aria-label={t("project.preset.name")}
          maxLength={64}
          onChange={(event) => setPresetName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveUserPreset();
          }}
          placeholder={t("project.preset.placeholder")}
          value={presetName}
        />
        <button
          aria-label={t("project.preset.save")}
          disabled={!selectedLayer?.effects.length || !presetName.trim()}
          onClick={saveUserPreset}
          title={t("project.preset.saveHint")}
          type="button"
        >
          <Save size={12} />
        </button>
      </div>
      {presetError && <div className="preset-error">{uiErrorMessage(t, presetError)}</div>}
      {filteredUserPresets.length > 0 && (
        <div className="effect-group user-preset-group">
          <div className="effect-category">
            <ChevronDown size={13} /> {t("project.preset.mine")}{" "}
            <small>{filteredUserPresets.length}</small>
          </div>
          {filteredUserPresets.map((preset) => (
            <div className="effect-entry" key={preset.id}>
              <button
                className="effect-apply"
                disabled={!state.selection[0]}
                onClick={() => applyUserPreset(preset.id)}
                title={
                  state.selection[0]
                    ? t("project.preset.applyOneUndo")
                    : t("project.effect.selectLayer")
                }
                type="button"
              >
                <span className="effect-icon user-preset">
                  <Save size={13} />
                </span>
                <span>
                  <strong>{preset.name}</strong>
                  <small>{t("project.preset.effectCount", { count: preset.effects.length })}</small>
                </span>
              </button>
              <button
                aria-label={t("project.preset.delete", { name: preset.name })}
                className="effect-favorite preset-delete"
                onClick={() =>
                  setUserPresets((current) => removeUserEffectPreset(current, preset.id))
                }
                title={t("project.preset.deleteShort", { name: preset.name })}
                type="button"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {filteredPresets.length > 0 && (
        <div className="effect-group preset-group">
          <div className="effect-category">
            <ChevronDown size={13} /> {t("project.preset.looks")}{" "}
            <small>{filteredPresets.length}</small>
          </div>
          {filteredPresets.map((preset) => (
            <button
              disabled={!state.selection[0]}
              key={preset.id}
              onClick={() => applyPreset(preset.id)}
              title={state.selection[0] ? preset.description : t("project.effect.selectLayer")}
              type="button"
            >
              <span
                className="effect-icon preset"
                style={
                  {
                    "--preset-a": preset.palette[0],
                    "--preset-b": preset.palette[1],
                    "--preset-c": preset.palette[2],
                  } as CSSProperties
                }
              >
                <Sparkles size={13} />
              </span>
              <span>
                <strong>{preset.name}</strong>
                <small>{t("project.preset.lookCount", { count: preset.effects.length })}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {favoriteEffects.length > 0 && (
        <EffectCatalogGroup
          effects={favoriteEffects}
          favorites={effectPreferences.favorites}
          icon="favorite"
          onApply={applyEffect}
          onToggleFavorite={(type) =>
            setEffectPreferences((preferences) => toggleFavoriteEffect(preferences, type))
          }
          selected={Boolean(state.selection[0])}
          title={t("project.effect.favorites")}
        />
      )}
      {recentEffects.length > 0 && (
        <EffectCatalogGroup
          effects={recentEffects}
          favorites={effectPreferences.favorites}
          icon="recent"
          onApply={applyEffect}
          onToggleFavorite={(type) =>
            setEffectPreferences((preferences) => toggleFavoriteEffect(preferences, type))
          }
          selected={Boolean(state.selection[0])}
          title={t("project.effect.recent")}
        />
      )}
      {effectCategories().map((category) => {
        const effects = filteredEffects.filter((effect) => effect.category === category);
        if (effects.length === 0) return null;
        return (
          <EffectCatalogGroup
            effects={effects}
            favorites={effectPreferences.favorites}
            key={category}
            onApply={applyEffect}
            onToggleFavorite={(type) =>
              setEffectPreferences((preferences) => toggleFavoriteEffect(preferences, type))
            }
            selected={Boolean(state.selection[0])}
            title={category}
          />
        );
      })}
    </div>
  );
}

function EffectCatalogGroup({
  effects,
  favorites,
  icon,
  onApply,
  onToggleFavorite,
  selected,
  title,
}: {
  effects: EffectDefinition[];
  favorites: string[];
  icon?: "favorite" | "recent";
  onApply: (type: string) => void;
  onToggleFavorite: (type: string) => void;
  selected: boolean;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <div className={`effect-group ${icon ? "shortcut-group" : ""}`}>
      <div className="effect-category">
        {icon === "favorite" ? (
          <Star fill="currentColor" size={11} />
        ) : icon === "recent" ? (
          <Clock3 size={11} />
        ) : (
          <ChevronDown size={13} />
        )}
        {title} <small>{effects.length}</small>
      </div>
      {effects.map((effect) => {
        const favorite = favorites.includes(effect.type);
        return (
          <div className="effect-entry" key={effect.type}>
            <button
              className="effect-apply"
              disabled={!selected}
              onClick={() => onApply(effect.type)}
              title={selected ? effect.description : t("project.effect.selectLayer")}
              type="button"
            >
              <span className={`effect-icon ${effect.execution}`}>
                <Sparkles size={13} />
              </span>
              <span>
                <strong>{effect.name}</strong>
                <small>
                  {t("project.effect.execution", {
                    execution: effect.execution.replace("-", " "),
                  })}
                </small>
              </span>
            </button>
            <button
              aria-label={t("project.effect.toggleFavorite", { type: effect.type })}
              className={`effect-favorite ${favorite ? "active" : ""}`}
              onClick={() => onToggleFavorite(effect.type)}
              title={
                favorite
                  ? t("project.effect.removeFavorite", { name: effect.name })
                  : t("project.effect.addFavorite", { name: effect.name })
              }
              type="button"
            >
              <Star fill={favorite ? "currentColor" : "none"} size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function localPreferenceStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
