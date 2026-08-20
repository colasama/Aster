import {
  Box,
  Camera,
  ChevronDown,
  Clock3,
  FileImage,
  Film,
  Folder,
  Layers3,
  Link2,
  Plus,
  Save,
  Search,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Type,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createMediaLayerFromFile } from "../core/assets";
import { createLayerForComposition } from "../core/layer-factory";
import { readPluginStatus } from "../core/plugins";
import { activeComposition } from "../core/project";
import { relinkProjectAsset } from "../core/project-file";
import type { LayerKind } from "../core/types";
import {
  readEffectBrowserPreferences,
  recordRecentEffect,
  toggleFavoriteEffect,
  writeEffectBrowserPreferences,
} from "../effects/browser-preferences";
import {
  getPluginEffectDefinitions,
  subscribePluginEffectDefinitions,
  synchronizePluginEffectDefinitions,
} from "../effects/plugin-registry";
import { createEffectsFromPreset, LOOK_PRESETS } from "../effects/presets";
import {
  createEffect,
  EFFECT_BY_TYPE,
  EFFECT_REGISTRY,
  effectCategories,
} from "../effects/registry";
import type { EffectDefinition } from "../effects/types";
import {
  addUserEffectPreset,
  createEffectsFromUserPreset,
  createUserEffectPreset,
  readUserEffectPresets,
  removeUserEffectPreset,
  writeUserEffectPresets,
} from "../effects/user-presets";
import { type UiErrorCode, uiErrorMessage } from "../i18n/errors";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { Panel, PanelTabs } from "./Panel";

const layerIcon: Record<LayerKind, typeof Shapes> = {
  shape: Shapes,
  text: Type,
  image: FileImage,
  video: Film,
  mesh: Box,
  particle: Sparkles,
  camera: Camera,
  light: Sparkles,
  precomposition: Layers3,
  adjustment: SlidersHorizontal,
};

export function ProjectPanel() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [assetError, setAssetError] = useState<UiErrorCode>();
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
  const imagePickerRef = useRef<HTMLInputElement>(null);
  const videoPickerRef = useRef<HTMLInputElement>(null);
  const composition = activeComposition(state.project);
  const mediaLayers = useMemo(
    () =>
      composition.layers.filter((layer) =>
        layer.asset?.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [composition.layers, query],
  );
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
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
    let active = true;
    void readPluginStatus()
      .then((status) => {
        if (active) synchronizePluginEffectDefinitions(status);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    writeUserEffectPresets(localPreferenceStorage(), userPresets);
  }, [userPresets]);
  const addLayer = (kind: LayerKind) => {
    const layer = createLayerForComposition(kind, composition, state.currentTime);
    dispatch({
      type: "operation",
      operations: [{ type: "addLayer", layer }],
      select: [layer.id],
    });
  };
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
    } catch {
      setPresetError("presetSave");
    }
  };
  const importMedia = async (kind: "image" | "video", file: File) => {
    try {
      setAssetError(undefined);
      const layer = await createMediaLayerFromFile(kind, file, composition, state.currentTime);
      dispatch({
        type: "operation",
        operations: [{ type: "addLayer", layer }],
        select: [layer.id],
      });
    } catch {
      setAssetError(kind === "image" ? "assetImageImport" : "assetVideoImport");
    }
  };
  const relinkSelectedAsset = async () => {
    if (!selectedLayer) return;
    try {
      setAssetError(undefined);
      const asset = await relinkProjectAsset(selectedLayer);
      if (asset)
        dispatch({
          type: "operation",
          operations: [{ type: "setLayerAsset", layerId: selectedLayer.id, asset }],
        });
    } catch {
      setAssetError("assetRelink");
    }
  };
  return (
    <Panel
      className="project-panel"
      tabs={
        <PanelTabs
          active={state.leftTab}
          onChange={(tab) => dispatch({ type: "setLeftTab", tab: tab as "project" | "effects" })}
          tabs={[
            { id: "project", label: t("project.tab.project") },
            { id: "effects", label: t("project.tab.effects") },
          ]}
        />
      }
      actions={
        <button aria-label={t("project.addItem")} onClick={() => addLayer("shape")} type="button">
          <Plus size={14} />
        </button>
      }
    >
      <div className="panel-search">
        <Search size={13} />
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("project.search")}
          value={query}
        />
      </div>
      {state.leftTab === "project" ? (
        <div className="project-tree">
          <div className="tree-row folder">
            <ChevronDown size={13} />
            <Folder fill="currentColor" size={15} />
            <span>{state.project.name}</span>
          </div>
          {state.project.compositions.map((candidate) => (
            <button
              className={`tree-row composition ${candidate.id === composition.id ? "active" : ""}`}
              key={candidate.id}
              onClick={() =>
                dispatch({ type: "setActiveComposition", compositionId: candidate.id })
              }
              type="button"
            >
              {candidate.id === composition.id ? (
                <ChevronDown size={13} />
              ) : (
                <span className="tree-spacer" />
              )}
              <Layers3 size={15} />
              <span>{candidate.name}</span>
              <small>
                {candidate.width} × {candidate.height}
              </small>
            </button>
          ))}
          <div className="tree-row asset-folder">
            <span className="tree-spacer" />
            <Folder size={14} />
            <span>{t("project.assets")}</span>
            <small>{mediaLayers.length}</small>
          </div>
          {mediaLayers.map((layer) => (
            <button
              className={`tree-row asset ${state.selection.includes(layer.id) ? "selected" : ""} ${layer.asset?.dataUrl || layer.asset?.runtimeUrl ? "" : "missing"}`}
              key={`asset:${layer.id}`}
              onClick={() => dispatch({ type: "select", ids: [layer.id] })}
              title={
                layer.asset?.dataUrl || layer.asset?.runtimeUrl
                  ? t("project.asset.locate", { name: layer.asset.name })
                  : t("project.asset.missingTitle", { name: layer.asset?.name ?? layer.name })
              }
              type="button"
            >
              <span className="tree-spacer" />
              {layer.kind === "video" ? <Film size={14} /> : <FileImage size={14} />}
              <span>{layer.asset?.name}</span>
              <small>
                {layer.asset?.dataUrl || layer.asset?.runtimeUrl ? (
                  <>
                    {layer.asset.width}×{layer.asset.height}
                    {layer.asset.duration ? ` · ${layer.asset.duration.toFixed(1)}s` : ""}
                  </>
                ) : (
                  t("project.asset.missing")
                )}
              </small>
            </button>
          ))}
          {composition.layers
            .filter((layer) => layer.name.toLowerCase().includes(query.toLowerCase()))
            .map((layer) => {
              const Icon = layerIcon[layer.kind];
              return (
                <button
                  className={`tree-row layer ${state.selection.includes(layer.id) ? "selected" : ""}`}
                  key={layer.id}
                  onClick={() => dispatch({ type: "select", ids: [layer.id] })}
                  type="button"
                >
                  <span className="tree-spacer" />
                  <Icon size={14} />
                  <span>{layer.name}</span>
                </button>
              );
            })}
          <div className="project-footer">
            <input
              accept="image/*"
              aria-label={t("project.asset.chooseImage")}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importMedia("image", file);
                event.target.value = "";
              }}
              ref={imagePickerRef}
              type="file"
            />
            <input
              accept="video/*"
              aria-label={t("project.asset.chooseVideo")}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importMedia("video", file);
                event.target.value = "";
              }}
              ref={videoPickerRef}
              type="file"
            />
            <button onClick={() => imagePickerRef.current?.click()} type="button">
              <FileImage size={13} /> {t("project.add.image")}
            </button>
            <button onClick={() => videoPickerRef.current?.click()} type="button">
              <Film size={13} /> {t("project.add.video")}
            </button>
            <button onClick={() => addLayer("text")} type="button">
              <Type size={13} /> {t("project.add.text")}
            </button>
            <button onClick={() => addLayer("shape")} type="button">
              <Shapes size={13} /> {t("project.add.shape")}
            </button>
            <button onClick={() => addLayer("adjustment")} type="button">
              <SlidersHorizontal size={13} /> {t("project.add.adjustment")}
            </button>
            <button onClick={() => addLayer("mesh")} type="button">
              <Box size={13} /> {t("project.add.mesh")}
            </button>
            {selectedLayer?.asset && (
              <button onClick={() => void relinkSelectedAsset()} type="button">
                <Link2 size={13} /> {t("project.asset.relink")}
              </button>
            )}
          </div>
          {assetError && <div className="project-error">{uiErrorMessage(t, assetError)}</div>}
        </div>
      ) : (
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
                      <small>
                        {t("project.preset.effectCount", { count: preset.effects.length })}
                      </small>
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
      )}
    </Panel>
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
