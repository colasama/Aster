import {
  Box,
  Camera,
  ChevronDown,
  Clock3,
  FileImage,
  Film,
  Folder,
  Layers3,
  Plus,
  Save,
  Search,
  Shapes,
  Sparkles,
  Star,
  Trash2,
  Type,
} from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createMediaLayerFromFile } from "../core/assets";
import { createLayerForComposition } from "../core/layer-factory";
import { activeComposition } from "../core/project";
import type { LayerKind } from "../core/types";
import {
  readEffectBrowserPreferences,
  recordRecentEffect,
  toggleFavoriteEffect,
  writeEffectBrowserPreferences,
} from "../effects/browser-preferences";
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
};

export function ProjectPanel() {
  const { state, dispatch } = useEditor();
  const [query, setQuery] = useState("");
  const [assetError, setAssetError] = useState<string>();
  const [presetError, setPresetError] = useState<string>();
  const [presetName, setPresetName] = useState("");
  const [effectPreferences, setEffectPreferences] = useState(() =>
    readEffectBrowserPreferences(localPreferenceStorage()),
  );
  const [userPresets, setUserPresets] = useState(() =>
    readUserEffectPresets(localPreferenceStorage()),
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
  const filteredEffects = useMemo(
    () =>
      EFFECT_REGISTRY.filter((effect) =>
        `${effect.name} ${effect.category} ${effect.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [query],
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
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : "Could not save preset");
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
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : `${kind} import failed`);
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
            { id: "project", label: "Project" },
            { id: "effects", label: "Effects & Presets" },
          ]}
        />
      }
      actions={
        <button aria-label="Add item" onClick={() => addLayer("shape")} type="button">
          <Plus size={14} />
        </button>
      }
    >
      <div className="panel-search">
        <Search size={13} />
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
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
            <span>Assets</span>
            <small>{mediaLayers.length}</small>
          </div>
          {mediaLayers.map((layer) => (
            <button
              className={`tree-row asset ${state.selection.includes(layer.id) ? "selected" : ""} ${layer.asset?.dataUrl ? "" : "missing"}`}
              key={`asset:${layer.id}`}
              onClick={() => dispatch({ type: "select", ids: [layer.id] })}
              title={
                layer.asset?.dataUrl
                  ? `Locate ${layer.asset.name} in the active composition`
                  : `${layer.asset?.name ?? layer.name} is missing its embedded source`
              }
              type="button"
            >
              <span className="tree-spacer" />
              {layer.kind === "video" ? <Film size={14} /> : <FileImage size={14} />}
              <span>{layer.asset?.name}</span>
              <small>
                {layer.asset?.dataUrl ? (
                  <>
                    {layer.asset.width}×{layer.asset.height}
                    {layer.asset.duration ? ` · ${layer.asset.duration.toFixed(1)}s` : ""}
                  </>
                ) : (
                  "Missing source"
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
              aria-label="Choose image asset"
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
              aria-label="Choose video asset"
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
              <FileImage size={13} /> Image
            </button>
            <button onClick={() => videoPickerRef.current?.click()} type="button">
              <Film size={13} /> Video
            </button>
            <button onClick={() => addLayer("text")} type="button">
              <Type size={13} /> Text
            </button>
            <button onClick={() => addLayer("shape")} type="button">
              <Shapes size={13} /> Shape
            </button>
            <button onClick={() => addLayer("mesh")} type="button">
              <Box size={13} /> 3D
            </button>
          </div>
          {assetError && <div className="project-error">{assetError}</div>}
        </div>
      ) : (
        <div className="effect-list">
          <div className="user-preset-save">
            <input
              aria-label="Custom effect preset name"
              maxLength={64}
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveUserPreset();
              }}
              placeholder="Save selected chain as preset"
              value={presetName}
            />
            <button
              aria-label="Save selected effect chain"
              disabled={!selectedLayer?.effects.length || !presetName.trim()}
              onClick={saveUserPreset}
              title="Save masks, parameters, and animation as a reusable preset"
              type="button"
            >
              <Save size={12} />
            </button>
          </div>
          {presetError && <div className="preset-error">{presetError}</div>}
          {filteredUserPresets.length > 0 && (
            <div className="effect-group user-preset-group">
              <div className="effect-category">
                <ChevronDown size={13} /> My Presets <small>{filteredUserPresets.length}</small>
              </div>
              {filteredUserPresets.map((preset) => (
                <div className="effect-entry" key={preset.id}>
                  <button
                    className="effect-apply"
                    disabled={!state.selection[0]}
                    onClick={() => applyUserPreset(preset.id)}
                    title={state.selection[0] ? "Apply as one undo step" : "Select a layer first"}
                    type="button"
                  >
                    <span className="effect-icon user-preset">
                      <Save size={13} />
                    </span>
                    <span>
                      <strong>{preset.name}</strong>
                      <small>{preset.effects.length} effects · masks & animation</small>
                    </span>
                  </button>
                  <button
                    aria-label={`Delete custom preset ${preset.name}`}
                    className="effect-favorite preset-delete"
                    onClick={() =>
                      setUserPresets((current) => removeUserEffectPreset(current, preset.id))
                    }
                    title={`Delete ${preset.name}`}
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
                <ChevronDown size={13} /> Looks Presets <small>{filteredPresets.length}</small>
              </div>
              {filteredPresets.map((preset) => (
                <button
                  disabled={!state.selection[0]}
                  key={preset.id}
                  onClick={() => applyPreset(preset.id)}
                  title={state.selection[0] ? preset.description : "Select a layer first"}
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
                    <small>{preset.effects.length} effects · one undo</small>
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
              title="Favorites"
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
              title="Recently Used"
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
              title={selected ? effect.description : "Select a layer first"}
              type="button"
            >
              <span className={`effect-icon ${effect.execution}`}>
                <Sparkles size={13} />
              </span>
              <span>
                <strong>{effect.name}</strong>
                <small>{effect.execution.replace("-", " ")} · GPU</small>
              </span>
            </button>
            <button
              aria-label={`Toggle favorite ${effect.type}`}
              className={`effect-favorite ${favorite ? "active" : ""}`}
              onClick={() => onToggleFavorite(effect.type)}
              title={`${favorite ? "Remove" : "Add"} ${effect.name} ${favorite ? "from" : "to"} favorites`}
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
