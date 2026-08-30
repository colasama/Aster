import {
  Box,
  ChevronDown,
  Circle,
  Command,
  Hand,
  LoaderCircle,
  MousePointer2,
  PenTool,
  Play,
  Redo2,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import {
  type ComponentType,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { importMediaLayer } from "../core/assets";
import { createParticleLayerForComposition } from "../core/bundled-particle";
import { createGltfLayerFromFile } from "../core/gltf";
import { createLayerForComposition } from "../core/layer-factory";
import { getProperty } from "../core/operations";
import { planPrecomposition } from "../core/precomposition";
import { activeComposition, createBlankComposition, createBlankProject } from "../core/project";
import {
  clearCurrentProjectPath,
  clearRecoverySnapshot,
  downloadBlob,
  packCurrentProject,
  pickPackedProject,
  pickProjectFile,
  readRecoverySnapshotForCurrentProject,
} from "../core/project-file";
import {
  nativeMp4ExportAvailable,
  nativeSequenceExportAvailable,
  type RenderSequenceProgress,
  renderMp4,
  renderPngSequence,
  renderSingleFrame,
} from "../core/render-export";
import { evaluateAnimatable } from "../core/timeline";
import { createId, type LayerKind, type Project } from "../core/types";
import { exportDiagnostics } from "../desktop/api";
import { useDocumentLifecycle } from "../desktop/use-document-lifecycle";
import { createEffect } from "../effects/registry";
import { reportUiError } from "../errors/report-ui-error";
import type { PlainMessageKey, Translate } from "../i18n/core";
import { useI18n } from "../i18n/react";
import { mediaImportRuntime } from "../importers/media-import-runtime";
import { useEditor } from "../state/editor-store";
import { isComposingKeyboardEvent, isEditableShortcutTarget } from "../ui/keyboard-shortcuts";
import { findMenuEntry, type MenuId, type MenuItemId, menuDefinitions } from "./topbar-menu";
import {
  renderTopBarToast,
  type TopBarToastActions,
  toastError,
  toastMessage,
  useTopBarToast,
} from "./topbar-toast";
import { useDialogFocus } from "./use-dialog-focus";
import { WindowControls } from "./WindowControls";
import type { WorkspaceDialogKind } from "./WorkspaceDialog";
import { WorkspaceWindowMenu } from "./workspace/WorkspaceWindowMenu";

const WorkspaceDialog = lazy(() =>
  import("./WorkspaceDialog").then((module) => ({ default: module.WorkspaceDialog })),
);

interface ToolDefinition {
  id: string;
  icon: ComponentType<{ size?: number }>;
  labelKey: PlainMessageKey;
}

type RenderFormat = "mp4" | "png" | "project" | "sequence";

const tools: ToolDefinition[] = [
  { id: "select", icon: MousePointer2, labelKey: "topbar.tool.select" },
  { id: "hand", icon: Hand, labelKey: "topbar.tool.hand" },
  { id: "rotate", icon: RotateCcw, labelKey: "topbar.tool.rotate" },
  { id: "shape", icon: Square, labelKey: "topbar.tool.rectangle" },
  { id: "ellipse", icon: Circle, labelKey: "topbar.tool.ellipse" },
  { id: "pen", icon: PenTool, labelKey: "topbar.tool.pen" },
  { id: "text", icon: Type, labelKey: "topbar.tool.text" },
  { id: "3d", icon: Box, labelKey: "topbar.tool.gizmo3d" },
];

export function TopBar() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [activeMenu, setActiveMenu] = useState<MenuId>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderFormat, setRenderFormat] = useState<RenderFormat>("png");
  const [renderProgress, setRenderProgress] = useState<RenderSequenceProgress>();
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogKind>();
  const toast = useTopBarToast();
  const toastActions = useMemo<TopBarToastActions>(
    () => ({ beginRequest: toast.beginRequest, show: toast.show }),
    [toast.beginRequest, toast.show],
  );
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const renderFormatRef = useRef<HTMLSelectElement>(null);
  const meshInputRef = useRef<HTMLInputElement>(null);
  const cancelRenderRef = useRef(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeRender = useCallback(() => {
    if (rendering) cancelRenderRef.current = true;
    else setRenderOpen(false);
  }, [rendering]);
  const paletteDialogRef = useDialogFocus<HTMLDivElement>({
    initialFocusRef: paletteInputRef,
    onClose: closePalette,
    open: paletteOpen,
  });
  const renderDialogRef = useDialogFocus<HTMLDivElement>({
    initialFocusRef: renderFormatRef,
    onClose: closeRender,
    open: renderOpen,
  });
  const lifecycle = useDocumentLifecycle(state, dispatch);
  const saveWithToast = useCallback(
    async (chooseDirectory = false, requestToken = toastActions.beginRequest()) => {
      try {
        const path = await lifecycle.save(chooseDirectory);
        if (!path) return false;
        toastActions.show(
          toastMessage("topbar.toast.saved", { name: path.split(/[\\/]/).pop() || path }),
          requestToken,
        );
        return true;
      } catch (error) {
        reportUiError(t, "projectSave", error, {
          scope: { area: "project", projectId: state.project.id },
        });
        toastActions.show(toastError("projectSave"), requestToken);
        return false;
      }
    },
    [lifecycle.save, state.project.id, t, toastActions],
  );
  const commands = useMemo(
    () => [
      {
        label: t("topbar.command.save"),
        action: () => void saveWithToast(),
      },
      {
        label: t("topbar.command.graph"),
        action: () => dispatch({ type: "setBottomMode", mode: "graph" }),
      },
      { label: t("topbar.command.ai"), action: () => dispatch({ type: "setRightTab", tab: "ai" }) },
      {
        label: t("topbar.command.fit"),
        action: () => dispatch({ type: "setViewportZoom", zoom: 0.22 }),
      },
      {
        label: state.playing ? t("topbar.command.pause") : t("topbar.command.play"),
        action: () => dispatch({ type: "setPlaying", playing: !state.playing }),
      },
      { label: t("topbar.command.render"), action: () => setRenderOpen(true) },
    ],
    [dispatch, saveWithToast, state.playing, t],
  );
  const filteredCommands = commands.filter((command) =>
    command.label.toLowerCase().includes(paletteQuery.toLowerCase()),
  );
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event)) return;
      const isEditing = isEditableShortcutTarget(event.target);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveWithToast();
      } else if (event.key === "Escape") {
        closePalette();
        closeRender();
        setWorkspaceDialog(undefined);
        setActiveMenu(undefined);
      } else if (!isEditing) {
        const tool = {
          v: "select",
          h: "hand",
          w: "rotate",
          q: "shape",
          g: "pen",
          t: "text",
        }[event.key.toLowerCase()] as typeof state.activeTool | undefined;
        if (tool) dispatch({ type: "setActiveTool", tool });
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [closePalette, closeRender, dispatch, saveWithToast]);
  const handleMenuItem = (item: MenuItemId) => {
    setActiveMenu(undefined);
    const composition = activeComposition(state.project);
    const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
    const layerTypes: Partial<Record<MenuItemId, LayerKind>> = {
      newText: "text",
      newShape: "shape",
      newSolid: "solid",
      newNull: "null",
      newAudio: "audio",
      newMesh: "mesh",
      newCamera: "camera",
      newLight: "light",
      newParticles: "generator",
    };
    const effectTypes: Partial<Record<MenuItemId, string>> = {
      glow: "glow",
      blur: "kawase-blur",
      colorMatrix: "color-matrix",
      looks: "looks-color-lab",
    };
    if (item === "newProject") {
      void lifecycle.guardReplacement().then(async (confirmed) => {
        if (!confirmed) return;
        await clearRecoverySnapshot();
        clearCurrentProjectPath();
        dispatch({ type: "loadProject", project: createBlankProject(), markSaved: false });
      });
    } else if (item === "open")
      void openProjectFile(
        dispatch,
        toastActions,
        lifecycle.guardReplacement,
        lifecycle.refreshPreferences,
        t,
      );
    else if (item === "openPacked")
      void openPackedProject(
        dispatch,
        toastActions,
        lifecycle.guardReplacement,
        lifecycle.refreshPreferences,
        t,
      );
    else if (item === "recoverAutosave") {
      const requestToken = toastActions.beginRequest();
      void lifecycle
        .guardReplacement()
        .then((confirmed) => (confirmed ? readRecoverySnapshotForCurrentProject() : null))
        .then((recovery) => {
          if (recovery) {
            dispatch({ type: "loadProject", project: recovery, markSaved: false });
            toastActions.show(toastMessage("topbar.toast.recovered"), requestToken);
          } else if (recovery === undefined)
            toastActions.show(toastMessage("topbar.toast.noRecovery"), requestToken);
        })
        .catch((error: unknown) => {
          reportUiError(t, "projectRecovery", error, {
            scope: { area: "project", projectId: state.project.id },
          });
          toastActions.show(toastError("projectRecovery"), requestToken);
        });
    } else if (item === "saveProject" || item === "saveAs") void saveWithToast(item === "saveAs");
    else if (item === "packProject")
      void packProject(state.project, lifecycle.save, toastActions, t);
    else if (item === "undo") dispatch({ type: "undo" });
    else if (item === "redo") dispatch({ type: "redo" });
    else if (item === "duplicate" && selectedLayer) {
      const duplicate = structuredClone(selectedLayer);
      duplicate.id = createId();
      duplicate.name = t("topbar.toast.copySuffix", { name: duplicate.name });
      duplicate.effects.forEach((effect) => {
        effect.id = createId();
      });
      dispatch({
        type: "operation",
        operations: [{ type: "addLayer", layer: duplicate }],
        select: [duplicate.id],
      });
    } else if (item === "newComposition") {
      const next = createBlankComposition(
        t("topbar.toast.compositionName", { number: state.project.compositions.length + 1 }),
      );
      dispatch({
        type: "operation",
        operations: [{ type: "addComposition", composition: next, activate: true }],
        select: [],
      });
    } else if (item === "precompose" && state.selection.length > 0) {
      const plan = planPrecomposition(state.project, state.selection);
      if (!plan) {
        toastActions.show(toastMessage("topbar.error.precomposeSelection"));
        return;
      }
      dispatch({
        type: "operation",
        operations: [{ type: "precomposeLayers", ...plan }],
        select: [plan.wrapper.id],
      });
      toastActions.show(
        toastMessage("topbar.toast.created", { name: plan.nestedComposition.name }),
      );
    } else if (item === "importImage" || item === "importVideo" || item === "importAudio") {
      const kind = item === "importImage" ? "image" : item === "importVideo" ? "video" : "audio";
      const requestToken = toastActions.beginRequest();
      void importMediaLayer(kind, composition, state.currentTime)
        .then((imported) => {
          if (!imported) return;
          const existing = state.project.sources.find(
            (source) => source.contentIdentity === imported.source.contentIdentity,
          );
          const source = existing ?? imported.source;
          if (existing) mediaImportRuntime.move(imported.source.id, existing.id);
          const layer = { ...imported.layer, sourceId: source.id };
          dispatch({
            type: "operation",
            operations: [
              ...(!existing ? ([{ type: "addSource", source }] as const) : []),
              { type: "addLayer", layer },
            ],
            select: [layer.id],
          });
          toastActions.show(
            toastMessage("topbar.toast.imported", { name: source.name }),
            requestToken,
          );
        })
        .catch((error: unknown) => {
          reportUiError(t, "mediaImport", error, {
            scope: {
              area: "composition",
              projectId: state.project.id,
              compositionId: composition.id,
            },
          });
          toastActions.show(toastError("mediaImport"), requestToken);
        });
    } else if (item === "importMesh") {
      meshInputRef.current?.click();
    } else if (layerTypes[item]) {
      const kind = layerTypes[item];
      const layer =
        kind === "generator"
          ? createParticleLayerForComposition(composition, state.currentTime)
          : createLayerForComposition(kind, composition, state.currentTime);
      dispatch({
        type: "operation",
        operations: [{ type: "addLayer", layer }],
        select: [layer.id],
      });
    } else if (effectTypes[item] && selectedLayer) {
      dispatch({
        type: "operation",
        operations: [
          { type: "addEffect", layerId: selectedLayer.id, effect: createEffect(effectTypes[item]) },
        ],
      });
    } else if (item === "addKeyframe" && selectedLayer) {
      dispatch({
        type: "operation",
        operations: [
          {
            type: "addKeyframe",
            layerId: selectedLayer.id,
            path: "opacity",
            keyframe: {
              id: createId(),
              time: state.currentTime,
              value: evaluateAnimatable(getProperty(selectedLayer, "opacity"), state.currentTime),
              interpolation: "bezier",
              easing: [0.16, 1, 0.3, 1],
            },
          },
        ],
      });
    } else if (item === "graphEditor") dispatch({ type: "setBottomMode", mode: "graph" });
    else if (item === "easyEase" && selectedLayer) {
      dispatch({
        type: "operation",
        operations: [{ type: "easeLayer", layerId: selectedLayer.id }],
      });
      toastActions.show(toastMessage("topbar.toast.easyEase", { name: selectedLayer.name }));
    } else if (item === "expressionEditor") setWorkspaceDialog("expression");
    else if (item === "preferences") setWorkspaceDialog("preferences");
    else if (item === "compositionSettings") setWorkspaceDialog("composition");
    else if (item === "keyboardShortcuts") setWorkspaceDialog("shortcuts");
    else if (item === "about") setWorkspaceDialog("about");
    else if (item === "plugins") setWorkspaceDialog("plugins");
    else if (item === "aiOperator") dispatch({ type: "setRightTab", tab: "ai" });
    else if (item === "fitComposition" || item === "viewport")
      dispatch({ type: "setViewportZoom", zoom: 0.22 });
    else if (item === "zoomIn")
      dispatch({ type: "setViewportZoom", zoom: state.viewportZoom * 1.15 });
    else if (item === "zoomOut")
      dispatch({ type: "setViewportZoom", zoom: state.viewportZoom / 1.15 });
    else if (item === "renderQueue" || item === "exportFrame") setRenderOpen(true);
    else if (item === "commandPalette") setPaletteOpen(true);
    else if (item === "toggleGuides") dispatch({ type: "toggleView", view: "guides" });
    else if (item === "project") dispatch({ type: "setLeftTab", tab: "project" });
    else if (item === "properties") dispatch({ type: "setRightTab", tab: "properties" });
    else if (item === "timeline") dispatch({ type: "setBottomMode", mode: "timeline" });
    else if (item === "gpuDiagnostics") {
      toastActions.show(
        toastMessage("topbar.toast.gpuMetrics", {
          fps: state.metrics.fps.toFixed(0),
          frameMs: state.metrics.frameMs.toFixed(2),
          passes: state.metrics.passCount,
        }),
      );
    } else if (item === "exportDiagnostics") {
      const requestToken = toastActions.beginRequest();
      void exportDiagnostics()
        .then((path) => {
          if (path)
            toastActions.show(
              toastMessage("topbar.toast.diagnosticsExported", {
                name: path.split(/[\\/]/).pop() || path,
              }),
              requestToken,
            );
        })
        .catch((error: unknown) => {
          reportUiError(t, "diagnosticsExport", error, { scope: { area: "application" } });
          toastActions.show(toastError("diagnosticsExport"), requestToken);
        });
    } else {
      const definition = findMenuEntry(item);
      if (definition) toastActions.show({ kind: "nextStep", itemKey: definition.labelKey });
    }
  };
  return (
    <>
      <input
        accept=".gltf,.glb,model/gltf+json,model/gltf-binary"
        aria-label={t("topbar.a11y.importMesh")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const requestToken = toastActions.beginRequest();
          void createGltfLayerFromFile(file, activeComposition(state.project), state.currentTime)
            .then((layer) => {
              dispatch({
                type: "operation",
                operations: [{ type: "addLayer", layer }],
                select: [layer.id],
              });
              toastActions.show(
                toastMessage("topbar.toast.imported", { name: layer.name }),
                requestToken,
              );
            })
            .catch((error: unknown) => {
              reportUiError(t, "meshImport", error, {
                scope: {
                  area: "asset",
                  projectId: state.project.id,
                  compositionId: activeComposition(state.project).id,
                  assetName: file.name,
                },
              });
              toastActions.show(toastError("meshImport"), requestToken);
            });
        }}
        ref={meshInputRef}
        style={{ display: "none" }}
        type="file"
      />
      <div className="title-bar">
        <div className="brand-mark">A</div>
        <div className="menu-strip">
          {menuDefinitions.map((menu) => (
            <div className="menu-root" key={menu.id}>
              <button
                aria-controls={`app-menu-${menu.id}`}
                aria-expanded={activeMenu === menu.id}
                aria-haspopup="menu"
                className={activeMenu === menu.id ? "active" : ""}
                onClick={() => setActiveMenu(activeMenu === menu.id ? undefined : menu.id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown") return;
                  event.preventDefault();
                  setActiveMenu(menu.id);
                  queueMicrotask(() =>
                    document
                      .querySelector<HTMLButtonElement>(`#app-menu-${menu.id} [role^=menuitem]`)
                      ?.focus(),
                  );
                }}
                type="button"
              >
                {t(menu.labelKey)}
              </button>
              {activeMenu === menu.id && (
                <div
                  className="app-menu-popover"
                  id={`app-menu-${menu.id}`}
                  role={menu.id === "window" ? undefined : "menu"}
                >
                  {menu.id === "window" ? (
                    <WorkspaceWindowMenu onClose={() => setActiveMenu(undefined)} />
                  ) : (
                    menu.items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => handleMenuItem(item.id)}
                        role="menuitem"
                        type="button"
                      >
                        <span>{t(item.labelKey)}</span>
                        {"shortcut" in item && <kbd>{item.shortcut}</kbd>}
                      </button>
                    ))
                  )}
                  {menu.id === "file" && lifecycle.recentProjects.length > 0 && (
                    <>
                      <div className="app-menu-heading">{t("topbar.recentProjects")}</div>
                      {lifecycle.recentProjects.map((path) => (
                        <button
                          key={path}
                          onClick={() => {
                            setActiveMenu(undefined);
                            void lifecycle.openRecent(path).then((opened) => {
                              if (!opened) toastActions.show(toastError("projectOpen"));
                            });
                          }}
                          title={path}
                          type="button"
                        >
                          <span>{path.split(/[\\/]/).pop() || path}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="document-title">
          {lifecycle.dirty && <span className="unsaved-dot" />} {state.project.name} — Aster
          {state.autosave.status !== "idle" && (
            <small className={`autosave-state ${state.autosave.status}`}>
              {t(`topbar.autosave.${state.autosave.status}`)}
            </small>
          )}
        </div>
        <div className="title-actions">
          <button className="command-hint" onClick={() => setPaletteOpen(true)} type="button">
            <Command size={13} /> K
          </button>
        </div>
        <WindowControls />
      </div>
      <div className="tool-bar">
        <div className="tool-group">
          {tools.map(({ id, icon: Icon, labelKey }) => (
            <button
              aria-pressed={state.activeTool === id}
              className={state.activeTool === id ? "active" : ""}
              key={id}
              onClick={() =>
                dispatch({ type: "setActiveTool", tool: id as typeof state.activeTool })
              }
              title={t(labelKey)}
              type="button"
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
        <div className="tool-divider" />
        <button
          disabled={!state.history.past.length}
          onClick={() => dispatch({ type: "undo" })}
          title={t("topbar.item.undo")}
          type="button"
        >
          <Undo2 size={16} />
        </button>
        <button
          disabled={!state.history.future.length}
          onClick={() => dispatch({ type: "redo" })}
          title={t("topbar.item.redo")}
          type="button"
        >
          <Redo2 size={16} />
        </button>
        <div className="toolbar-center">
          <button
            className="preview-quality"
            onClick={() => {
              const quality =
                state.previewQuality === 1 ? 0.5 : state.previewQuality === 0.5 ? 0.25 : 1;
              dispatch({ type: "setPreviewQuality", quality });
            }}
            title={t("topbar.toolbar.previewResolution")}
            type="button"
          >
            {state.previewQuality === 1
              ? t("common.full")
              : state.previewQuality === 0.5
                ? t("common.half")
                : t("common.quarter")}{" "}
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="toolbar-right">
          <button className="render-button" onClick={() => setRenderOpen(true)} type="button">
            <Play fill="currentColor" size={13} /> {t("topbar.toolbar.render")}
          </button>
        </div>
      </div>
      {paletteOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            aria-label={t("topbar.command.placeholder")}
            aria-modal="true"
            className="command-palette"
            ref={paletteDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <button
              aria-label={t("topbar.command.close")}
              className="palette-close"
              onClick={closePalette}
              type="button"
            >
              <X size={13} />
            </button>
            <div className="palette-search">
              <Search size={15} />
              <input
                onChange={(event) => setPaletteQuery(event.target.value)}
                placeholder={t("topbar.command.placeholder")}
                ref={paletteInputRef}
                value={paletteQuery}
              />
            </div>
            <small>{t("topbar.command.quick")}</small>
            {filteredCommands.map((command) => (
              <button
                key={command.label}
                onClick={() => {
                  command.action();
                  closePalette();
                }}
                type="button"
              >
                <Command size={12} />
                <span>{command.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {renderOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            aria-label={t("topbar.render.title")}
            aria-modal="true"
            className="render-dialog"
            ref={renderDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <strong>{t("topbar.render.title")}</strong>
              <button
                aria-label={t("topbar.command.close")}
                disabled={rendering}
                onClick={closeRender}
                type="button"
              >
                <X size={14} />
              </button>
            </header>
            <div className="render-summary">
              <Sparkles size={20} />
              <div>
                <strong>{t("topbar.render.pipeline")}</strong>
                <span>
                  {renderFormat === "mp4"
                    ? t("topbar.render.videoSummary", {
                        duration: activeComposition(state.project).duration,
                      })
                    : renderFormat === "sequence"
                      ? t("topbar.render.sequenceSummary", {
                          duration: activeComposition(state.project).duration,
                        })
                      : t("topbar.render.frameSummary")}
                </span>
              </div>
            </div>
            <label>
              {t("topbar.render.outputFormat")}
              <select
                onChange={(event) => setRenderFormat(event.target.value as RenderFormat)}
                ref={renderFormatRef}
                value={renderFormat}
              >
                <option disabled={!nativeMp4ExportAvailable()} value="mp4">
                  {t("topbar.render.mp4")}
                </option>
                <option value="png">{t("topbar.render.png")}</option>
                <option disabled={!nativeSequenceExportAvailable()} value="sequence">
                  {t("topbar.render.sequence")}
                </option>
                <option value="project">{t("topbar.render.project")}</option>
              </select>
            </label>
            {renderProgress && (
              <div className="render-progress">
                <progress max={renderProgress.total} value={renderProgress.current} />
                <span>
                  {t("topbar.render.progress", {
                    current: renderProgress.current,
                    total: renderProgress.total,
                  })}
                </span>
              </div>
            )}
            <footer>
              <button onClick={closeRender} type="button">
                {rendering ? t("topbar.render.stopAfterFrame") : t("common.cancel")}
              </button>
              <button
                className="primary"
                disabled={rendering}
                onClick={async () => {
                  const requestToken = toastActions.beginRequest();
                  cancelRenderRef.current = false;
                  setRenderProgress(undefined);
                  setRendering(true);
                  try {
                    if (renderFormat === "project") await saveWithToast(false, requestToken);
                    else if (renderFormat === "png") {
                      const blob = await renderSingleFrame(state.currentTime);
                      downloadBlob(blob, "aster-frame-4k.png");
                      toastActions.show(
                        toastMessage("topbar.toast.exportedPng", {
                          width: activeComposition(state.project).width,
                          height: activeComposition(state.project).height,
                        }),
                        requestToken,
                      );
                    } else if (renderFormat === "mp4") {
                      const result = await renderMp4(
                        state.project,
                        activeComposition(state.project),
                        setRenderProgress,
                        () => cancelRenderRef.current,
                      );
                      if (!result) return;
                      toastActions.show(
                        result.cancelled
                          ? toastMessage("topbar.toast.stoppedMp4", { frames: result.frames })
                          : toastMessage("topbar.toast.exportedMp4", {
                              frames: result.frames,
                              encoder: result.encoder ?? "H.264",
                            }),
                        requestToken,
                      );
                    } else {
                      const result = await renderPngSequence(
                        state.project,
                        activeComposition(state.project),
                        setRenderProgress,
                        () => cancelRenderRef.current,
                      );
                      if (!result) return;
                      toastActions.show(
                        result.cancelled
                          ? toastMessage("topbar.toast.stoppedFrames", { frames: result.frames })
                          : toastMessage("topbar.toast.exportedFrames", {
                              frames: result.frames,
                            }),
                        requestToken,
                      );
                    }
                    setRenderOpen(false);
                  } catch (error) {
                    reportUiError(t, "frameExport", error, {
                      scope: {
                        area: "render",
                        projectId: state.project.id,
                        compositionId: activeComposition(state.project).id,
                      },
                    });
                    toastActions.show(toastError("frameExport"), requestToken);
                  } finally {
                    setRendering(false);
                    setRenderProgress(undefined);
                  }
                }}
                type="button"
              >
                {rendering ? (
                  <>
                    <LoaderCircle className="spin" size={12} />
                    {renderFormat === "mp4"
                      ? t("topbar.render.renderingVideo")
                      : renderFormat === "sequence"
                        ? t("topbar.render.renderingSequence")
                        : t("topbar.render.rendering4k")}
                  </>
                ) : (
                  <>
                    <Play size={12} />
                    {renderFormat === "mp4"
                      ? t("topbar.render.renderVideo")
                      : renderFormat === "sequence"
                        ? t("topbar.render.renderSequence")
                        : t("topbar.render.renderFrame")}
                  </>
                )}
              </button>
            </footer>
          </div>
        </div>
      )}
      {workspaceDialog && (
        <Suspense fallback={null}>
          <WorkspaceDialog kind={workspaceDialog} onClose={() => setWorkspaceDialog(undefined)} />
        </Suspense>
      )}
      {toast.toast && (
        <div className="app-toast">{renderTopBarToast(t, toast.toast.descriptor)}</div>
      )}
    </>
  );
}

async function openProjectFile(
  dispatch: ReturnType<typeof useEditor>["dispatch"],
  toast: TopBarToastActions,
  guardReplacement: () => Promise<boolean>,
  refreshPreferences: () => Promise<unknown>,
  t: Translate,
) {
  const requestToken = toast.beginRequest();
  try {
    const selected = await pickProjectFile(guardReplacement);
    if (!selected) return;
    dispatch({ type: "loadProject", project: selected.project, markSaved: true });
    await refreshPreferences();
    toast.show(toastMessage("topbar.toast.opened", { name: selected.name }), requestToken);
  } catch (error) {
    reportUiError(t, "projectOpen", error, { scope: { area: "project" } });
    toast.show(toastError("projectOpen"), requestToken);
  }
}

async function openPackedProject(
  dispatch: ReturnType<typeof useEditor>["dispatch"],
  toast: TopBarToastActions,
  guardReplacement: () => Promise<boolean>,
  refreshPreferences: () => Promise<unknown>,
  t: Translate,
) {
  const requestToken = toast.beginRequest();
  try {
    const selected = await pickPackedProject(guardReplacement);
    if (!selected) return;
    dispatch({ type: "loadProject", project: selected.project, markSaved: true });
    await refreshPreferences();
    toast.show(toastMessage("topbar.toast.unpacked", { name: selected.name }), requestToken);
  } catch (error) {
    reportUiError(t, "projectPackedOpen", error, { scope: { area: "project" } });
    toast.show(toastError("projectPackedOpen"), requestToken);
  }
}

async function packProject(
  project: Project,
  saveProject: () => Promise<string | undefined>,
  toast: TopBarToastActions,
  t: Translate,
): Promise<void> {
  const requestToken = toast.beginRequest();
  try {
    const saved = await saveProject();
    const path = saved ? await packCurrentProject(project.name) : undefined;
    if (path)
      toast.show(
        toastMessage("topbar.toast.packed", { name: path.split(/[\\/]/).pop() || path }),
        requestToken,
      );
  } catch (error) {
    reportUiError(t, "projectPack", error, {
      scope: { area: "project", projectId: project.id },
    });
    toast.show(toastError("projectPack"), requestToken);
  }
}
