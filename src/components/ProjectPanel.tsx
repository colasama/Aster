import {
  Box,
  ChevronDown,
  ChevronRight,
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
import type { DragEvent } from "react";
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
import { activeComposition, createBlankComposition } from "../core/project";
import { relinkProjectAsset } from "../core/project-file";
import { createId, type Id, type Layer, type LayerKind, type ProjectFolder } from "../core/types";
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

const ROOT_ASSETS_ID = "root-assets";
const PROJECT_ITEM_MIME = "application/x-aster-project-item";

interface MediaProjectItem {
  compositionId: Id;
  layer: Layer;
}

export function ProjectPanel() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [assetError, setAssetError] = useState<UiErrorCode>();
  const [presetError, setPresetError] = useState<UiErrorCode>();
  const [presetName, setPresetName] = useState("");
  const [addTarget, setAddTarget] = useState<{ folderId?: Id; label: string }>();
  const [expandedFolders, setExpandedFolders] = useState(() => new Set([ROOT_ASSETS_ID]));
  const [draggedItemId, setDraggedItemId] = useState<Id>();
  const [dropTargetId, setDropTargetId] = useState<Id>();
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
  const addMenuRef = useRef<HTMLElement>(null);
  const composition = activeComposition(state.project);
  const mediaItems = useMemo<MediaProjectItem[]>(
    () =>
      state.project.compositions.flatMap((candidate) =>
        candidate.layers
          .filter((layer) => layer.asset)
          .map((layer) => ({ compositionId: candidate.id, layer })),
      ),
    [state.project.compositions],
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
  useEffect(() => {
    if (!addTarget) return;
    const closeMenu = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddTarget(undefined);
    };
    document.addEventListener("pointerdown", closeMenu, true);
    return () => document.removeEventListener("pointerdown", closeMenu, true);
  }, [addTarget]);
  const addLayer = (kind: LayerKind) => {
    const layer = createLayerForComposition(kind, composition, state.currentTime);
    dispatch({
      type: "operation",
      operations: [{ type: "addLayer", layer }],
      select: [layer.id],
    });
    setAddTarget(undefined);
  };
  const openAddDrawer = (folderId?: Id, label = t("project.assets")) => {
    if (state.leftTab !== "project") dispatch({ type: "setLeftTab", tab: "project" });
    setAddTarget({ folderId, label });
  };
  const createFolder = () => {
    const folder: ProjectFolder = {
      id: createId(),
      name: t("project.folder.defaultName", { number: state.project.folders.length + 1 }),
      ...(addTarget?.folderId ? { parentId: addTarget.folderId } : {}),
    };
    dispatch({ type: "operation", operations: [{ type: "addProjectFolder", folder }] });
    setExpandedFolders((current) => new Set(current).add(addTarget?.folderId ?? ROOT_ASSETS_ID));
    setAddTarget(undefined);
  };
  const createComposition = () => {
    const next = createBlankComposition(
      t("project.composition.defaultName", { number: state.project.compositions.length + 1 }),
    );
    dispatch({
      type: "operation",
      operations: [
        { type: "addComposition", composition: next, activate: true },
        ...(addTarget?.folderId
          ? ([
              {
                type: "moveProjectItem",
                itemId: next.id,
                folderId: addTarget.folderId,
              },
            ] as const)
          : []),
      ],
      select: [],
    });
    setExpandedFolders((current) => new Set(current).add(addTarget?.folderId ?? ROOT_ASSETS_ID));
    setAddTarget(undefined);
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
  const importMedia = async (kind: "image" | "video", file: File, folderId?: Id) => {
    try {
      setAssetError(undefined);
      const layer = await createMediaLayerFromFile(kind, file, composition, state.currentTime);
      dispatch({
        type: "operation",
        operations: [
          { type: "addLayer", layer },
          ...(folderId ? ([{ type: "moveProjectItem", itemId: layer.id, folderId }] as const) : []),
        ],
        select: [layer.id],
      });
      setExpandedFolders((current) => new Set(current).add(folderId ?? ROOT_ASSETS_ID));
      setAddTarget(undefined);
    } catch {
      setAssetError(kind === "image" ? "assetImageImport" : "assetVideoImport");
    }
  };
  const toggleFolder = (folderId: Id) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };
  const moveItemToFolder = (itemId: Id, folderId?: Id) => {
    if (state.project.itemFolderIds[itemId] === folderId) return;
    dispatch({
      type: "operation",
      operations: [{ type: "moveProjectItem", itemId, folderId }],
    });
    setExpandedFolders((current) => new Set(current).add(folderId ?? ROOT_ASSETS_ID));
  };
  const startItemDrag = (event: DragEvent<HTMLElement>, itemId: Id) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(PROJECT_ITEM_MIME, itemId);
    setDraggedItemId(itemId);
  };
  const dropItem = (event: DragEvent<HTMLElement>, folderId?: Id) => {
    event.preventDefault();
    const itemId = event.dataTransfer.getData(PROJECT_ITEM_MIME) || draggedItemId;
    if (itemId) moveItemToFolder(itemId, folderId);
    setDraggedItemId(undefined);
    setDropTargetId(undefined);
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
  const normalizedQuery = query.trim().toLowerCase();
  const matchingCompositions = state.project.compositions.filter((candidate) =>
    candidate.name.toLowerCase().includes(normalizedQuery),
  );
  const matchingMediaItems = mediaItems.filter((item) =>
    (item.layer.asset?.name ?? item.layer.name).toLowerCase().includes(normalizedQuery),
  );
  const itemCountInFolder = (folderId?: Id): number => {
    const direct =
      state.project.compositions.filter(
        (candidate) => state.project.itemFolderIds[candidate.id] === folderId,
      ).length +
      mediaItems.filter((item) => state.project.itemFolderIds[item.layer.id] === folderId).length;
    return state.project.folders
      .filter((folder) => folder.parentId === folderId)
      .reduce((count, folder) => count + itemCountInFolder(folder.id), direct);
  };
  const renderProjectItem = (
    item:
      | { kind: "composition"; id: Id; compositionId: Id }
      | { kind: "media"; id: Id; media: MediaProjectItem },
    depth: number,
  ) => {
    if (item.kind === "composition") {
      const candidate = state.project.compositions.find((entry) => entry.id === item.compositionId);
      if (!candidate) return null;
      return (
        <button
          className={`tree-row composition project-item ${candidate.id === composition.id ? "active" : ""} ${draggedItemId === candidate.id ? "dragging" : ""}`}
          draggable
          key={`composition:${candidate.id}`}
          onClick={() => dispatch({ type: "setActiveComposition", compositionId: candidate.id })}
          onDragEnd={() => setDraggedItemId(undefined)}
          onDragStart={(event) => startItemDrag(event, candidate.id)}
          style={{ "--tree-depth": depth } as CSSProperties}
          type="button"
        >
          <Layers3 size={14} />
          <span>{candidate.name}</span>
          <small>
            {candidate.width} × {candidate.height}
          </small>
        </button>
      );
    }
    const { layer, compositionId } = item.media;
    const asset = layer.asset;
    return (
      <button
        className={`tree-row asset project-item ${state.selection.includes(layer.id) ? "selected" : ""} ${asset?.dataUrl || asset?.runtimeUrl ? "" : "missing"} ${draggedItemId === layer.id ? "dragging" : ""}`}
        draggable
        key={`asset:${layer.id}`}
        onClick={() => {
          if (compositionId !== composition.id)
            dispatch({ type: "setActiveComposition", compositionId });
          dispatch({ type: "select", ids: [layer.id] });
        }}
        onDragEnd={() => setDraggedItemId(undefined)}
        onDragStart={(event) => startItemDrag(event, layer.id)}
        style={{ "--tree-depth": depth } as CSSProperties}
        title={
          asset?.dataUrl || asset?.runtimeUrl
            ? t("project.asset.locate", { name: asset.name })
            : t("project.asset.missingTitle", { name: asset?.name ?? layer.name })
        }
        type="button"
      >
        {layer.kind === "video" ? <Film size={14} /> : <FileImage size={14} />}
        <span>{asset?.name ?? layer.name}</span>
        <small>
          {asset?.dataUrl || asset?.runtimeUrl ? (
            <>
              {asset.width}×{asset.height}
              {asset.duration ? ` · ${asset.duration.toFixed(1)}s` : ""}
            </>
          ) : (
            t("project.asset.missing")
          )}
        </small>
      </button>
    );
  };
  const renderItemsInFolder = (folderId: Id | undefined, depth: number) => {
    const compositions = matchingCompositions
      .filter((candidate) => state.project.itemFolderIds[candidate.id] === folderId)
      .map((candidate) => ({
        kind: "composition" as const,
        id: candidate.id,
        compositionId: candidate.id,
      }));
    const media = matchingMediaItems
      .filter((item) => state.project.itemFolderIds[item.layer.id] === folderId)
      .map((item) => ({ kind: "media" as const, id: item.layer.id, media: item }));
    return [...compositions, ...media].map((item) => renderProjectItem(item, depth));
  };
  const renderFolder = (folder: ProjectFolder, depth: number) => {
    const expanded = expandedFolders.has(folder.id);
    const dropTarget = dropTargetId === folder.id;
    return (
      <div className="asset-folder-node" key={folder.id}>
        <div
          aria-expanded={expanded}
          className={`tree-row asset-folder ${dropTarget ? "drop-target" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDropTargetId(folder.id);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDropTargetId(undefined);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => dropItem(event, folder.id)}
          role="treeitem"
          style={{ "--tree-depth": depth } as CSSProperties}
          tabIndex={-1}
        >
          <button
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t("project.folder.collapse", { name: folder.name })
                : t("project.folder.expand", { name: folder.name })
            }
            className="folder-toggle"
            onClick={() => toggleFolder(folder.id)}
            type="button"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Folder fill="currentColor" size={14} />
            <span>{folder.name}</span>
          </button>
          <small>{itemCountInFolder(folder.id)}</small>
          <button
            aria-label={t("project.folder.addTo", { name: folder.name })}
            className="folder-add"
            onClick={() => openAddDrawer(folder.id, folder.name)}
            title={t("project.folder.addTo", { name: folder.name })}
            type="button"
          >
            <Plus size={12} />
          </button>
        </div>
        {expanded && (
          <>
            {state.project.folders
              .filter((candidate) => candidate.parentId === folder.id)
              .map((candidate) => renderFolder(candidate, depth + 1))}
            {renderItemsInFolder(folder.id, depth + 1)}
          </>
        )}
      </div>
    );
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
        <button
          aria-expanded={Boolean(addTarget)}
          aria-label={t("project.addItem")}
          onClick={() => (addTarget ? setAddTarget(undefined) : openAddDrawer())}
          type="button"
        >
          <Plus size={14} />
        </button>
      }
    >
      <input
        accept="image/*"
        aria-label={t("project.asset.chooseImage")}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importMedia("image", file, addTarget?.folderId);
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
          if (file) void importMedia("video", file, addTarget?.folderId);
          event.target.value = "";
        }}
        ref={videoPickerRef}
        type="file"
      />
      <div className="panel-search">
        <Search size={13} />
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("project.search")}
          value={query}
        />
      </div>
      {state.leftTab === "project" ? (
        <div className="project-tree" role="tree">
          <div className="tree-row folder">
            <Folder fill="currentColor" size={15} />
            <span>{state.project.name}</span>
          </div>
          <div
            aria-expanded={expandedFolders.has(ROOT_ASSETS_ID)}
            className={`tree-row asset-folder root-assets ${dropTargetId === ROOT_ASSETS_ID ? "drop-target" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDropTargetId(ROOT_ASSETS_ID);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                setDropTargetId(undefined);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => dropItem(event)}
            role="treeitem"
            style={{ "--tree-depth": 0 } as CSSProperties}
            tabIndex={-1}
          >
            <button
              aria-expanded={expandedFolders.has(ROOT_ASSETS_ID)}
              aria-label={
                expandedFolders.has(ROOT_ASSETS_ID)
                  ? t("project.folder.collapse", { name: t("project.assets") })
                  : t("project.folder.expand", { name: t("project.assets") })
              }
              className="folder-toggle"
              onClick={() => toggleFolder(ROOT_ASSETS_ID)}
              type="button"
            >
              {expandedFolders.has(ROOT_ASSETS_ID) ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              <Folder fill="currentColor" size={14} />
              <span>{t("project.assets")}</span>
            </button>
            <small>{state.project.compositions.length + mediaItems.length}</small>
            <button
              aria-label={t("project.folder.addTo", { name: t("project.assets") })}
              className="folder-add"
              onClick={() => openAddDrawer()}
              title={t("project.folder.addTo", { name: t("project.assets") })}
              type="button"
            >
              <Plus size={12} />
            </button>
          </div>
          {expandedFolders.has(ROOT_ASSETS_ID) && (
            <>
              {state.project.folders
                .filter((folder) => !folder.parentId)
                .map((folder) => renderFolder(folder, 1))}
              {renderItemsInFolder(undefined, 1)}
            </>
          )}
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
      {addTarget && (
        <aside aria-label={t("project.add.menuTitle")} className="asset-add-menu" ref={addMenuRef}>
          <div className="asset-add-heading">
            <span>
              <strong>{t("project.add.menuTitle")}</strong>
              <small>{t("project.add.destination", { name: addTarget.label })}</small>
            </span>
            <button
              aria-label={t("project.add.close")}
              onClick={() => setAddTarget(undefined)}
              type="button"
            >
              ×
            </button>
          </div>
          <div className="asset-add-group">
            <span>{t("project.add.projectItems")}</span>
            <div className="asset-add-grid">
              <button onClick={createFolder} type="button">
                <Folder size={15} /> {t("project.add.folder")}
              </button>
              <button onClick={createComposition} type="button">
                <Layers3 size={15} /> {t("project.add.composition")}
              </button>
              <button onClick={() => imagePickerRef.current?.click()} type="button">
                <FileImage size={15} /> {t("project.add.image")}
              </button>
              <button onClick={() => videoPickerRef.current?.click()} type="button">
                <Film size={15} /> {t("project.add.video")}
              </button>
            </div>
          </div>
          <div className="asset-add-group">
            <span>{t("project.add.layers")}</span>
            <div className="asset-add-grid">
              <button onClick={() => addLayer("text")} type="button">
                <Type size={15} /> {t("project.add.text")}
              </button>
              <button onClick={() => addLayer("shape")} type="button">
                <Shapes size={15} /> {t("project.add.shape")}
              </button>
              <button onClick={() => addLayer("adjustment")} type="button">
                <SlidersHorizontal size={15} /> {t("project.add.adjustment")}
              </button>
              <button onClick={() => addLayer("mesh")} type="button">
                <Box size={15} /> {t("project.add.mesh")}
              </button>
            </div>
          </div>
          {selectedLayer?.asset && (
            <button
              className="asset-relink"
              onClick={() => void relinkSelectedAsset()}
              type="button"
            >
              <Link2 size={14} /> {t("project.asset.relink")}
            </button>
          )}
        </aside>
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
