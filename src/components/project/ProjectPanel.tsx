import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileCode2,
  FileImage,
  Files,
  Film,
  Folder,
  Layers3,
  Link2,
  Music2,
  Plus,
  Search,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Square,
  Type,
} from "lucide-react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Operation } from "../../core/editing/operations";
import {
  createGeneratorLayerForComposition,
  createLayerForComposition,
  type StandardLayerKind,
} from "../../core/layers/layer-factory";
import { createMediaLayerForSource } from "../../core/media/assets";
import { activeComposition, createBlankComposition } from "../../core/project/project";
import { createParticleLayerForComposition } from "../../core/scene/bundled-particle";
import {
  createSceneGeneratorInstance,
  getSceneGeneratorDefinitions,
  type SceneGeneratorDefinition,
  subscribeSceneGeneratorDefinitions,
} from "../../core/scene/scene-generator-registry";
import {
  createId,
  type FootageSource,
  type Id,
  type Layer,
  type ProjectFolder,
} from "../../core/types";
import { uiErrorMessage } from "../../i18n/errors";
import { useI18n } from "../../i18n/react";
import { createBrowserSequenceInput } from "../../importers/advanced-import";
import type { MissingSequenceFramePolicy } from "../../importers/image-sequence-runtime";
import { mediaImportRuntime } from "../../importers/media-import-runtime";
import type { PsdImportMode } from "../../importers/psd-composition";
import { useEditor } from "../../state/editor-store";
import { useContextMenuTrigger } from "../context-menu/use-context-menu-trigger";
import { Panel, PanelTabs } from "../Panel";
import { EffectBrowser } from "./EffectBrowser";
import {
  ProjectContextMenu,
  type ProjectContextTarget,
  type ProjectImportKind,
} from "./ProjectContextMenu";
import {
  duplicateProjectComposition,
  projectFolderMoveDestinations,
  projectItemDeleteBlock,
} from "./project-item-commands";
import { useProjectImports } from "./use-project-imports";

const ROOT_ASSETS_ID = "root-assets";
const PROJECT_ITEM_MIME = "application/x-aster-project-item";

interface MediaProjectItem {
  source: FootageSource;
  instances: Array<{ compositionId: Id; layer: Layer }>;
}

export function ProjectPanel() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [addTarget, setAddTarget] = useState<{ folderId?: Id; label: string }>();
  const [expandedFolders, setExpandedFolders] = useState(() => new Set([ROOT_ASSETS_ID]));
  const [draggedItemId, setDraggedItemId] = useState<Id>();
  const [dropTargetId, setDropTargetId] = useState<Id>();
  const [projectContextTarget, setProjectContextTarget] = useState<ProjectContextTarget>();
  const projectContextMenu = useContextMenuTrigger();
  const pluginGenerators = useSyncExternalStore(
    subscribeSceneGeneratorDefinitions,
    getSceneGeneratorDefinitions,
    getSceneGeneratorDefinitions,
  );
  useSyncExternalStore(
    mediaImportRuntime.subscribe,
    mediaImportRuntime.revision,
    mediaImportRuntime.revision,
  );
  const addMenuRef = useRef<HTMLElement>(null);
  const composition = activeComposition(state.project);
  const mediaItems = useMemo<MediaProjectItem[]>(
    () =>
      state.project.sources.map((source) => ({
        source,
        instances: state.project.compositions.flatMap((candidate) =>
          candidate.layers
            .filter((layer) => layer.sourceId === source.id)
            .map((layer) => ({ compositionId: candidate.id, layer })),
        ),
      })),
    [state.project.compositions, state.project.sources],
  );
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
  const selectedSource = state.project.sources.find(
    (source) => source.id === selectedLayer?.sourceId,
  );
  const {
    assetError,
    assetErrorDetail,
    assetWarningCount,
    psdImportMode,
    setPsdImportMode,
    sequenceFrameRate,
    setSequenceFrameRate,
    missingFramePolicy,
    setMissingFramePolicy,
    imagePickerRef,
    svgPickerRef,
    psdPickerRef,
    sequencePickerRef,
    importMedia,
    chooseMedia,
    importSvg,
    importPsd,
    importSequence,
    chooseSvg,
    choosePsd,
    chooseSequence,
    reportAdvancedImportError,
    relinkAsset,
  } = useProjectImports(addTarget?.folderId, selectedSource, (folderId) => {
    setExpandedFolders((current) => new Set(current).add(folderId ?? ROOT_ASSETS_ID));
    setAddTarget(undefined);
  });
  useEffect(() => {
    if (!addTarget) return;
    const closeMenu = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddTarget(undefined);
    };
    document.addEventListener("pointerdown", closeMenu, true);
    return () => document.removeEventListener("pointerdown", closeMenu, true);
  }, [addTarget]);
  const addLayer = (kind: StandardLayerKind) => {
    const layer = createLayerForComposition(kind, composition, state.currentTime);
    dispatch({
      type: "operation",
      operations: [{ type: "addLayer", layer }],
      select: [layer.id],
    });
    setAddTarget(undefined);
  };
  const addParticles = () => {
    const layer = createParticleLayerForComposition(composition, state.currentTime);
    dispatch({
      type: "operation",
      operations: [{ type: "addLayer", layer }],
      select: [layer.id],
    });
    setAddTarget(undefined);
  };
  const addGenerator = (definition: SceneGeneratorDefinition) => {
    const layer = createGeneratorLayerForComposition(
      composition,
      createSceneGeneratorInstance(definition),
      state.currentTime,
      definition.pluginName,
    );
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
  const createFolder = (folderId = addTarget?.folderId) => {
    const folder: ProjectFolder = {
      id: createId(),
      name: t("project.folder.defaultName", { number: state.project.folders.length + 1 }),
      ...(folderId ? { parentId: folderId } : {}),
    };
    dispatch({ type: "operation", operations: [{ type: "addProjectFolder", folder }] });
    setExpandedFolders((current) => new Set(current).add(folderId ?? ROOT_ASSETS_ID));
    setAddTarget(undefined);
  };
  const createComposition = (folderId = addTarget?.folderId) => {
    const next = createBlankComposition(
      t("project.composition.defaultName", { number: state.project.compositions.length + 1 }),
    );
    dispatch({
      type: "operation",
      operations: [
        { type: "addComposition", composition: next, activate: true },
        ...(folderId
          ? ([
              {
                type: "moveProjectItem",
                itemId: next.id,
                folderId,
              },
            ] as const)
          : []),
      ],
      select: [],
    });
    setExpandedFolders((current) => new Set(current).add(folderId ?? ROOT_ASSETS_ID));
    setAddTarget(undefined);
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
  const openProjectContextFromPointer = (
    event: MouseEvent<HTMLElement>,
    target: ProjectContextTarget,
  ) => {
    setProjectContextTarget(target);
    projectContextMenu.openFromPointer(event);
  };
  const openProjectContextFromKeyboard = (
    event: KeyboardEvent<HTMLElement>,
    target: ProjectContextTarget,
  ) => {
    if (!projectContextMenu.openFromKeyboard(event)) return;
    setProjectContextTarget(target);
  };
  const contextImport = (kind: ProjectImportKind) => {
    const folderId = projectContextTarget?.kind === "folder" ? projectContextTarget.id : undefined;
    const label =
      projectContextTarget?.kind === "folder" ? projectContextTarget.name : t("project.assets");
    setAddTarget({ folderId, label });
    if (kind === "image") imagePickerRef.current?.click();
    else if (kind === "video") void chooseMedia("video", folderId);
    else if (kind === "audio") void chooseMedia("audio", folderId);
    else if (kind === "svg") void chooseSvg(folderId);
    else if (kind === "psd") void choosePsd(folderId);
    else void chooseSequence(folderId);
  };
  const renameContextTarget = () => {
    if (!projectContextTarget || projectContextTarget.kind === "empty") return;
    const name = window.prompt(t("project.menu.renamePrompt"), projectContextTarget.name);
    if (!name?.trim()) return;
    dispatch({
      type: "operation",
      operations: [{ type: "renameProjectItem", itemId: projectContextTarget.id, name }],
    });
  };
  const duplicateContextComposition = () => {
    if (projectContextTarget?.kind !== "composition") return;
    const source = state.project.compositions.find(
      (candidate) => candidate.id === projectContextTarget.id,
    );
    if (!source) return;
    const duplicate = duplicateProjectComposition(
      source,
      t("project.menu.copyName", { name: source.name }),
    );
    const folderId = state.project.itemFolderIds[source.id];
    dispatch({
      type: "operation",
      operations: [
        { type: "addComposition", composition: duplicate, activate: false },
        ...(folderId
          ? ([{ type: "moveProjectItem", itemId: duplicate.id, folderId }] as const)
          : []),
      ],
      select: [],
    });
  };
  const deleteContextTarget = () => {
    if (!projectContextTarget || projectContextTarget.kind === "empty") return;
    const operation: Operation =
      projectContextTarget.kind === "composition"
        ? { type: "removeComposition", compositionId: projectContextTarget.id }
        : projectContextTarget.kind === "source"
          ? { type: "removeSource", sourceId: projectContextTarget.id }
          : { type: "removeProjectFolder", folderId: projectContextTarget.id };
    dispatch({ type: "operation", operations: [operation], select: [] });
  };
  const moveContextTarget = (folderId?: Id) => {
    if (!projectContextTarget || projectContextTarget.kind === "empty") return;
    dispatch({
      type: "operation",
      operations: [
        projectContextTarget.kind === "folder"
          ? { type: "moveProjectFolder", folderId: projectContextTarget.id, parentId: folderId }
          : { type: "moveProjectItem", itemId: projectContextTarget.id, folderId },
      ],
    });
    setExpandedFolders((current) => new Set(current).add(folderId ?? ROOT_ASSETS_ID));
  };
  const normalizedQuery = query.trim().toLowerCase();
  const matchingCompositions = state.project.compositions.filter((candidate) =>
    candidate.name.toLowerCase().includes(normalizedQuery),
  );
  const matchingMediaItems = mediaItems.filter((item) =>
    item.source.name.toLowerCase().includes(normalizedQuery),
  );
  const itemCountInFolder = (folderId?: Id): number => {
    const direct =
      state.project.compositions.filter(
        (candidate) => state.project.itemFolderIds[candidate.id] === folderId,
      ).length +
      mediaItems.filter((item) => state.project.itemFolderIds[item.source.id] === folderId).length;
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
          onContextMenu={(event) =>
            openProjectContextFromPointer(event, {
              id: candidate.id,
              kind: "composition",
              name: candidate.name,
            })
          }
          onDragEnd={() => setDraggedItemId(undefined)}
          onDragStart={(event) => startItemDrag(event, candidate.id)}
          onKeyDown={(event) =>
            openProjectContextFromKeyboard(event, {
              id: candidate.id,
              kind: "composition",
              name: candidate.name,
            })
          }
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
    const { source, instances } = item.media;
    const runtimeError = mediaImportRuntime.error(source.id);
    const preferredInstance =
      instances.find((instance) => instance.compositionId === composition.id) ?? instances[0];
    return (
      <button
        className={`tree-row asset project-item ${preferredInstance && state.selection.includes(preferredInstance.layer.id) ? "selected" : ""} ${source.dataUrl || source.runtimeUrl ? "" : "missing"} ${runtimeError ? "runtime-error" : ""} ${draggedItemId === source.id ? "dragging" : ""}`}
        draggable
        key={`source:${source.id}`}
        onClick={() => {
          if (!preferredInstance) return;
          if (preferredInstance.compositionId !== composition.id)
            dispatch({
              type: "setActiveComposition",
              compositionId: preferredInstance.compositionId,
            });
          dispatch({ type: "select", ids: [preferredInstance.layer.id] });
        }}
        onContextMenu={(event) =>
          openProjectContextFromPointer(event, { id: source.id, kind: "source", name: source.name })
        }
        onDragEnd={() => setDraggedItemId(undefined)}
        onDragStart={(event) => startItemDrag(event, source.id)}
        onKeyDown={(event) =>
          openProjectContextFromKeyboard(event, {
            id: source.id,
            kind: "source",
            name: source.name,
          })
        }
        style={{ "--tree-depth": depth } as CSSProperties}
        title={
          runtimeError
            ? runtimeError
            : source.dataUrl || source.runtimeUrl
              ? t("project.asset.locate", { name: source.name })
              : t("project.asset.missingTitle", { name: source.name })
        }
        type="button"
      >
        {source.kind === "video" ? (
          <Film size={14} />
        ) : source.kind === "audio" ? (
          <Music2 size={14} />
        ) : (
          <FileImage size={14} />
        )}
        <span>{source.name}</span>
        <small>
          {runtimeError ? (
            t("project.asset.runtimeError")
          ) : source.dataUrl || source.runtimeUrl ? (
            <>
              {"width" in source && "height" in source ? `${source.width}×${source.height}` : ""}
              {"duration" in source ? ` · ${source.duration.toFixed(1)}s` : ""}
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
      .filter((item) => state.project.itemFolderIds[item.source.id] === folderId)
      .map((item) => ({ kind: "media" as const, id: item.source.id, media: item }));
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
          onContextMenu={(event) =>
            openProjectContextFromPointer(event, {
              id: folder.id,
              kind: "folder",
              name: folder.name,
            })
          }
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
          onKeyDown={(event) =>
            openProjectContextFromKeyboard(event, {
              id: folder.id,
              kind: "folder",
              name: folder.name,
            })
          }
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
  const contextComposition =
    projectContextTarget?.kind === "composition"
      ? state.project.compositions.find((candidate) => candidate.id === projectContextTarget.id)
      : undefined;
  const contextMedia =
    projectContextTarget?.kind === "source"
      ? mediaItems.find((item) => item.source.id === projectContextTarget.id)
      : undefined;
  const contextFolder =
    projectContextTarget?.kind === "folder"
      ? state.project.folders.find((folder) => folder.id === projectContextTarget.id)
      : undefined;
  const contextTargetExists = Boolean(
    projectContextTarget?.kind === "empty" || contextComposition || contextMedia || contextFolder,
  );
  const deleteBlock = projectContextTarget
    ? projectItemDeleteBlock(state.project, projectContextTarget)
    : undefined;
  const deleteUnavailableReason =
    deleteBlock === "finalComposition"
      ? t("project.menu.delete.finalComposition")
      : deleteBlock === "compositionReferenced"
        ? t("project.menu.delete.compositionReferenced")
        : deleteBlock === "sourceReferenced"
          ? t("project.menu.delete.sourceReferenced")
          : deleteBlock === "folderNotEmpty"
            ? t("project.menu.delete.folderNotEmpty")
            : t("project.menu.deleteUnavailable");
  const moveDestinations =
    projectContextTarget && projectContextTarget.kind !== "empty"
      ? (() => {
          const destinations = projectFolderMoveDestinations(state.project, projectContextTarget);
          return [
            ...(destinations.includeRoot ? [{ label: t("project.assets") }] : []),
            ...destinations.folders.map((folder) => ({
              id: folder.id,
              label: projectFolderPath(state.project.folders, folder),
            })),
          ];
        })()
      : [];
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
        accept="image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp,image/tiff,.png,.jpg,.jpeg,.webp,.avif,.gif,.bmp,.tif,.tiff"
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
        accept="image/svg+xml,.svg"
        aria-label={t("project.asset.chooseSvg")}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importSvg(file);
          event.target.value = "";
        }}
        ref={svgPickerRef}
        type="file"
      />
      <input
        accept="image/vnd.adobe.photoshop,.psd"
        aria-label={t("project.asset.choosePsd")}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importPsd(file);
          event.target.value = "";
        }}
        ref={psdPickerRef}
        type="file"
      />
      <input
        accept="image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp,image/tiff,.png,.jpg,.jpeg,.webp,.avif,.gif,.bmp,.tif,.tiff"
        aria-label={t("project.asset.chooseSequence")}
        hidden
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          if (files.length > 0) {
            void createBrowserSequenceInput(files, files[0]?.name)
              .then(importSequence)
              .catch((error: unknown) => reportAdvancedImportError(error, files[0]?.name));
          }
          event.target.value = "";
        }}
        ref={sequencePickerRef}
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
      {state.leftTab === "project" && (
        <div
          className="project-tree"
          onContextMenu={(event) => {
            if (event.target !== event.currentTarget) return;
            openProjectContextFromPointer(event, { kind: "empty" });
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            openProjectContextFromKeyboard(event, { kind: "empty" });
          }}
          role="tree"
          tabIndex={0}
        >
          <div className="tree-row folder">
            <Folder fill="currentColor" size={15} />
            <span>{state.project.name}</span>
          </div>
          <div
            aria-expanded={expandedFolders.has(ROOT_ASSETS_ID)}
            className={`tree-row asset-folder root-assets ${dropTargetId === ROOT_ASSETS_ID ? "drop-target" : ""}`}
            onContextMenu={(event) => openProjectContextFromPointer(event, { kind: "empty" })}
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
            onKeyDown={(event) => openProjectContextFromKeyboard(event, { kind: "empty" })}
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
          {assetError && (
            <div className="project-error" role="alert">
              <span>{uiErrorMessage(t, assetError)}</span>
              {assetErrorDetail && (
                <small className="project-error-detail">{assetErrorDetail}</small>
              )}
            </div>
          )}
          {assetWarningCount > 0 && (
            <div className="project-warning" role="status">
              {t("project.asset.importWarnings", { count: assetWarningCount })}
            </div>
          )}
        </div>
      )}
      <EffectBrowser query={query} hidden={state.leftTab === "project"} />
      {projectContextMenu.point && projectContextTarget && (
        <ProjectContextMenu
          addSourceToComposition={() => {
            if (!contextMedia) return;
            const layer = createMediaLayerForSource(
              contextMedia.source,
              composition,
              state.currentTime,
            );
            dispatch({
              type: "operation",
              operations: [{ type: "addLayer", layer }],
              select: [layer.id],
            });
          }}
          canAddSourceToComposition={Boolean(contextMedia)}
          canDelete={contextTargetExists && !deleteBlock}
          canDuplicate={Boolean(contextComposition)}
          canRelink={Boolean(
            contextMedia && ["still", "video", "audio"].includes(contextMedia.source.kind),
          )}
          canRename={contextTargetExists && projectContextTarget.kind !== "empty"}
          canRevealInComposition={Boolean(contextMedia?.instances.length)}
          createComposition={() =>
            createComposition(
              projectContextTarget.kind === "folder" ? projectContextTarget.id : undefined,
            )
          }
          createFolder={() =>
            createFolder(
              projectContextTarget.kind === "folder" ? projectContextTarget.id : undefined,
            )
          }
          deleteTarget={deleteContextTarget}
          deleteUnavailableReason={deleteUnavailableReason}
          duplicateTarget={duplicateContextComposition}
          importAsset={contextImport}
          moveDestinations={moveDestinations}
          moveTarget={moveContextTarget}
          onClose={projectContextMenu.close}
          openComposition={() => {
            if (contextComposition)
              dispatch({ type: "setActiveComposition", compositionId: contextComposition.id });
          }}
          relinkSource={() => void relinkAsset(contextMedia?.source)}
          renameTarget={renameContextTarget}
          revealInComposition={() => {
            const instance =
              contextMedia?.instances.find(
                (candidate) => candidate.compositionId === composition.id,
              ) ?? contextMedia?.instances[0];
            if (!instance) return;
            if (instance.compositionId !== composition.id)
              dispatch({ type: "setActiveComposition", compositionId: instance.compositionId });
            dispatch({ type: "select", ids: [instance.layer.id] });
          }}
          target={projectContextTarget}
          x={projectContextMenu.point.x}
          y={projectContextMenu.point.y}
        />
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
              <button onClick={() => createFolder()} type="button">
                <Folder size={15} /> {t("project.add.folder")}
              </button>
              <button onClick={() => createComposition()} type="button">
                <Layers3 size={15} /> {t("project.add.composition")}
              </button>
              <button onClick={() => imagePickerRef.current?.click()} type="button">
                <FileImage size={15} /> {t("project.add.image")}
              </button>
              <button onClick={() => void chooseSvg()} type="button">
                <FileCode2 size={15} /> {t("project.add.svg")}
              </button>
              <button onClick={() => void choosePsd()} type="button">
                <Layers3 size={15} /> {t("project.add.psd")}
              </button>
              <button onClick={() => void chooseSequence()} type="button">
                <Files size={15} /> {t("project.add.imageSequence")}
              </button>
              <button onClick={() => void chooseMedia("video")} type="button">
                <Film size={15} /> {t("project.add.video")}
              </button>
              <button onClick={() => void chooseMedia("audio")} type="button">
                <Music2 size={15} /> {t("project.add.audio")}
              </button>
            </div>
            <div className="advanced-import-settings">
              <label>
                <span>{t("project.asset.psdMode")}</span>
                <select
                  aria-label={t("project.asset.psdMode")}
                  onChange={(event) => setPsdImportMode(event.target.value as PsdImportMode)}
                  value={psdImportMode}
                >
                  <option value="merged">{t("project.asset.psdMode.merged")}</option>
                  <option value="composition">{t("project.asset.psdMode.composition")}</option>
                  <option value="compositionRetainLayerSizes">
                    {t("project.asset.psdMode.retainSizes")}
                  </option>
                </select>
              </label>
              <label>
                <span>{t("project.asset.sequenceRate")}</span>
                <span className="sequence-rate-input">
                  <input
                    aria-label={t("project.asset.sequenceRateNumerator")}
                    max={1000000}
                    min={1}
                    onChange={(event) =>
                      setSequenceFrameRate((current) => ({
                        ...current,
                        numerator: event.currentTarget.valueAsNumber,
                      }))
                    }
                    type="number"
                    value={sequenceFrameRate.numerator}
                  />
                  <span>/</span>
                  <input
                    aria-label={t("project.asset.sequenceRateDenominator")}
                    max={1000000}
                    min={1}
                    onChange={(event) =>
                      setSequenceFrameRate((current) => ({
                        ...current,
                        denominator: event.currentTarget.valueAsNumber,
                      }))
                    }
                    type="number"
                    value={sequenceFrameRate.denominator}
                  />
                </span>
              </label>
              <label>
                <span>{t("project.asset.missingFrames")}</span>
                <select
                  aria-label={t("project.asset.missingFrames")}
                  onChange={(event) =>
                    setMissingFramePolicy(event.target.value as MissingSequenceFramePolicy)
                  }
                  value={missingFramePolicy}
                >
                  <option value="error">{t("project.asset.missingFrames.error")}</option>
                  <option value="holdPrevious">
                    {t("project.asset.missingFrames.holdPrevious")}
                  </option>
                  <option value="nearest">{t("project.asset.missingFrames.nearest")}</option>
                </select>
              </label>
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
              <button onClick={() => addLayer("solid")} type="button">
                <Square size={15} /> {t("project.add.solid")}
              </button>
              <button onClick={() => addLayer("null")} type="button">
                <CircleDashed size={15} /> {t("project.add.null")}
              </button>
              <button onClick={() => addLayer("adjustment")} type="button">
                <SlidersHorizontal size={15} /> {t("project.add.adjustment")}
              </button>
              <button onClick={() => addLayer("mesh")} type="button">
                <Box size={15} /> {t("project.add.mesh")}
              </button>
              <button onClick={addParticles} type="button">
                <Sparkles size={15} /> {t("project.add.particles")}
              </button>
              {pluginGenerators.map((definition) => (
                <button
                  key={`${definition.pluginId}:${definition.nodeType}`}
                  onClick={() => addGenerator(definition)}
                  title={`${definition.pluginId} · v${definition.pluginVersion}`}
                  type="button"
                >
                  <Sparkles size={15} /> {definition.pluginName}
                </button>
              ))}
            </div>
          </div>
          {selectedSource && (
            <button className="asset-relink" onClick={() => void relinkAsset()} type="button">
              <Link2 size={14} /> {t("project.asset.relink")}
            </button>
          )}
        </aside>
      )}
    </Panel>
  );
}

function projectFolderPath(folders: readonly ProjectFolder[], folder: ProjectFolder): string {
  const names = [folder.name];
  const visited = new Set<Id>([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = folders.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}
