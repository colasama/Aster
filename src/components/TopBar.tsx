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
  Save,
  Search,
  Sparkles,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import { importMediaLayer } from "../core/assets";
import { createGltfLayerFromFile } from "../core/gltf";
import { createLayerForComposition } from "../core/layer-factory";
import { getProperty } from "../core/operations";
import { planPrecomposition } from "../core/precomposition";
import { activeComposition, createBlankComposition, createBlankProject } from "../core/project";
import {
  clearRecoverySnapshot,
  downloadBlob,
  packCurrentProject,
  pickPackedProject,
  pickProjectFile,
  readRecoverySnapshotForCurrentProject,
  saveProjectDocument,
} from "../core/project-file";
import {
  nativeSequenceExportAvailable,
  type RenderSequenceProgress,
  renderPngSequence,
  renderSingleFrame,
} from "../core/render-export";
import { evaluateAnimatable } from "../core/timeline";
import { createId, type LayerKind, type Project } from "../core/types";
import { createEffect } from "../effects/registry";
import type { PlainMessageKey, Translate } from "../i18n/core";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { findMenuEntry, type MenuId, type MenuItemId, menuDefinitions } from "./topbar-menu";
import { WorkspaceDialog, type WorkspaceDialogKind } from "./WorkspaceDialog";

interface ToolDefinition {
  id: string;
  icon: ComponentType<{ size?: number }>;
  labelKey: PlainMessageKey;
}

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
  const [renderFormat, setRenderFormat] = useState<"png" | "project" | "sequence">("png");
  const [renderProgress, setRenderProgress] = useState<RenderSequenceProgress>();
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogKind>();
  const [toast, setToast] = useState<string>();
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const meshInputRef = useRef<HTMLInputElement>(null);
  const cancelRenderRef = useRef(false);
  const commands = useMemo(
    () => [
      { label: t("topbar.command.save"), action: () => saveProject(state.project, setToast, t) },
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
    [dispatch, state.playing, state.project, t],
  );
  const filteredCommands = commands.filter((command) =>
    command.label.toLowerCase().includes(paletteQuery.toLowerCase()),
  );
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveProject(state.project, setToast, t);
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
        setRenderOpen(false);
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
  }, [dispatch, state.project, t]);
  useEffect(() => {
    if (paletteOpen) paletteInputRef.current?.focus();
  }, [paletteOpen]);
  const handleMenuItem = (item: MenuItemId) => {
    setActiveMenu(undefined);
    const composition = activeComposition(state.project);
    const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
    const layerTypes: Partial<Record<MenuItemId, LayerKind>> = {
      newText: "text",
      newShape: "shape",
      newMesh: "mesh",
      newCamera: "camera",
      newLight: "light",
      newParticles: "particle",
    };
    const effectTypes: Partial<Record<MenuItemId, string>> = {
      glow: "glow",
      blur: "kawase-blur",
      colorMatrix: "color-matrix",
      looks: "looks-color-lab",
    };
    if (item === "newProject") {
      clearRecoverySnapshot();
      dispatch({ type: "loadProject", project: createBlankProject() });
    } else if (item === "open") openProjectFile(dispatch, setToast, t);
    else if (item === "openPacked") openPackedProject(dispatch, setToast, t);
    else if (item === "recoverAutosave") {
      void readRecoverySnapshotForCurrentProject()
        .then((recovery) => {
          if (recovery) {
            dispatch({ type: "loadProject", project: recovery });
            showToast(setToast, t("topbar.toast.recovered"));
          } else showToast(setToast, t("topbar.toast.noRecovery"));
        })
        .catch((error: unknown) =>
          showToast(setToast, error instanceof Error ? error.message : t("topbar.error.recovery")),
        );
    } else if (item === "saveProject" || item === "saveAs")
      saveProject(state.project, setToast, t, item === "saveAs");
    else if (item === "packProject") packProject(state.project, setToast, t);
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
        showToast(setToast, t("topbar.error.precomposeSelection"));
        return;
      }
      dispatch({
        type: "operation",
        operations: [{ type: "precomposeLayers", ...plan }],
        select: [plan.wrapper.id],
      });
      showToast(setToast, t("topbar.toast.created", { name: plan.nestedComposition.name }));
    } else if (item === "importImage" || item === "importVideo") {
      const kind = item === "importImage" ? "image" : "video";
      void importMediaLayer(kind, composition, state.currentTime)
        .then((layer) => {
          if (!layer) return;
          dispatch({
            type: "operation",
            operations: [{ type: "addLayer", layer }],
            select: [layer.id],
          });
          showToast(
            setToast,
            t("topbar.toast.imported", { name: layer.asset?.name ?? layer.name }),
          );
        })
        .catch((error: unknown) =>
          showToast(
            setToast,
            error instanceof Error ? error.message : t("topbar.error.assetImport"),
          ),
        );
    } else if (item === "importMesh") {
      meshInputRef.current?.click();
    } else if (layerTypes[item]) {
      const layer = createLayerForComposition(layerTypes[item], composition, state.currentTime);
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
      showToast(setToast, t("topbar.toast.easyEase", { name: selectedLayer.name }));
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
      setToast(
        t("topbar.toast.gpuMetrics", {
          fps: state.metrics.fps.toFixed(0),
          frameMs: state.metrics.frameMs.toFixed(2),
          passes: state.metrics.passCount,
        }),
      );
      window.setTimeout(() => setToast(undefined), 2600);
    } else {
      const definition = findMenuEntry(item);
      setToast(t("topbar.toast.nextStep", { item: definition ? t(definition.labelKey) : item }));
      window.setTimeout(() => setToast(undefined), 1800);
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
          void createGltfLayerFromFile(file, activeComposition(state.project), state.currentTime)
            .then((layer) => {
              dispatch({
                type: "operation",
                operations: [{ type: "addLayer", layer }],
                select: [layer.id],
              });
              showToast(setToast, t("topbar.toast.imported", { name: layer.name }));
            })
            .catch((error: unknown) =>
              showToast(
                setToast,
                error instanceof Error ? error.message : t("topbar.error.meshImport"),
              ),
            );
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
                className={activeMenu === menu.id ? "active" : ""}
                onClick={() => setActiveMenu(activeMenu === menu.id ? undefined : menu.id)}
                type="button"
              >
                {t(menu.labelKey)}
              </button>
              {activeMenu === menu.id && (
                <div className="app-menu-popover">
                  {menu.items.map((item) => (
                    <button key={item.id} onClick={() => handleMenuItem(item.id)} type="button">
                      <span>{t(item.labelKey)}</span>
                      {"shortcut" in item && <kbd>{item.shortcut}</kbd>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="document-title">
          <span className="unsaved-dot" /> {state.project.name} — Aster
        </div>
        <div className="title-actions">
          <button
            aria-label={t("topbar.command.save")}
            onClick={() => saveProject(state.project, setToast, t)}
            type="button"
          >
            <Save size={14} />
          </button>
          <button className="command-hint" onClick={() => setPaletteOpen(true)} type="button">
            <Command size={13} /> K
          </button>
        </div>
      </div>
      <div className="tool-bar">
        <div className="tool-group">
          {tools.map(({ id, icon: Icon, labelKey }) => (
            <button
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
          <span className="gpu-badge">
            <Sparkles size={12} /> {t("topbar.toolbar.gpuPreview")}
          </span>
        </div>
        <div className="toolbar-right">
          <button
            className="search-button"
            onClick={() =>
              document
                .querySelector<HTMLInputElement>(".project-panel .panel-search input")
                ?.focus()
            }
            type="button"
          >
            <Search size={14} /> {t("topbar.toolbar.searchProject")}
          </button>
          <button className="render-button" onClick={() => setRenderOpen(true)} type="button">
            <Play fill="currentColor" size={13} /> {t("topbar.toolbar.render")}
          </button>
        </div>
      </div>
      {paletteOpen && (
        <div className="modal-backdrop">
          <div className="command-palette">
            <button
              aria-label={t("topbar.command.close")}
              className="palette-close"
              onClick={() => setPaletteOpen(false)}
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
                  setPaletteOpen(false);
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
          <div className="render-dialog">
            <header>
              <strong>{t("topbar.render.title")}</strong>
              <button disabled={rendering} onClick={() => setRenderOpen(false)} type="button">
                <X size={14} />
              </button>
            </header>
            <div className="render-summary">
              <Sparkles size={20} />
              <div>
                <strong>{t("topbar.render.pipeline")}</strong>
                <span>
                  {renderFormat === "sequence"
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
                onChange={(event) =>
                  setRenderFormat(event.target.value as "png" | "project" | "sequence")
                }
                value={renderFormat}
              >
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
              <button
                onClick={() => {
                  if (rendering) cancelRenderRef.current = true;
                  else setRenderOpen(false);
                }}
                type="button"
              >
                {rendering ? t("topbar.render.stopAfterFrame") : t("common.cancel")}
              </button>
              <button
                className="primary"
                disabled={rendering}
                onClick={async () => {
                  cancelRenderRef.current = false;
                  setRenderProgress(undefined);
                  setRendering(true);
                  try {
                    if (renderFormat === "project") saveProject(state.project, setToast, t);
                    else if (renderFormat === "png") {
                      const blob = await renderSingleFrame(state.currentTime);
                      downloadBlob(blob, "aster-frame-4k.png");
                      showToast(
                        setToast,
                        t("topbar.toast.exportedPng", {
                          width: activeComposition(state.project).width,
                          height: activeComposition(state.project).height,
                        }),
                      );
                    } else {
                      const result = await renderPngSequence(
                        activeComposition(state.project),
                        setRenderProgress,
                        () => cancelRenderRef.current,
                      );
                      if (!result) return;
                      showToast(
                        setToast,
                        result.cancelled
                          ? t("topbar.toast.stoppedFrames", { frames: result.frames })
                          : t("topbar.toast.exportedFrames", { frames: result.frames }),
                      );
                    }
                    setRenderOpen(false);
                  } catch (error) {
                    showToast(
                      setToast,
                      error instanceof Error ? error.message : t("topbar.error.frameExport"),
                    );
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
                    {renderFormat === "sequence"
                      ? t("topbar.render.renderingSequence")
                      : t("topbar.render.rendering4k")}
                  </>
                ) : (
                  <>
                    <Play size={12} />
                    {renderFormat === "sequence"
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
        <WorkspaceDialog kind={workspaceDialog} onClose={() => setWorkspaceDialog(undefined)} />
      )}
      {toast && <div className="app-toast">{toast}</div>}
    </>
  );
}

async function openProjectFile(
  dispatch: ReturnType<typeof useEditor>["dispatch"],
  setToast: (message: string | undefined) => void,
  t: Translate,
) {
  try {
    const selected = await pickProjectFile();
    if (!selected) return;
    dispatch({ type: "loadProject", project: selected.project });
    showToast(setToast, t("topbar.toast.opened", { name: selected.name }));
  } catch (error) {
    showToast(setToast, error instanceof Error ? error.message : t("topbar.error.openProject"));
  }
}

async function openPackedProject(
  dispatch: ReturnType<typeof useEditor>["dispatch"],
  setToast: (message: string | undefined) => void,
  t: Translate,
) {
  try {
    const selected = await pickPackedProject();
    if (!selected) return;
    dispatch({ type: "loadProject", project: selected.project });
    showToast(setToast, t("topbar.toast.unpacked", { name: selected.name }));
  } catch (error) {
    showToast(setToast, error instanceof Error ? error.message : t("topbar.error.openPacked"));
  }
}

function packProject(
  project: Project,
  setToast: (message: string | undefined) => void,
  t: Translate,
): void {
  void saveProjectDocument(project)
    .then((saved) => (saved ? packCurrentProject(project.name) : undefined))
    .then((path) => {
      if (path)
        showToast(setToast, t("topbar.toast.packed", { name: path.split(/[\\/]/).pop() || path }));
    })
    .catch((error: unknown) => {
      showToast(setToast, error instanceof Error ? error.message : t("topbar.error.packProject"));
    });
}

function saveProject(
  project: Project,
  setToast: (message: string | undefined) => void,
  t: Translate,
  chooseDirectory = false,
): void {
  void saveProjectDocument(project, chooseDirectory)
    .then((path) => {
      if (path)
        showToast(setToast, t("topbar.toast.saved", { name: path.split(/[\\/]/).pop() || path }));
    })
    .catch((error: unknown) => {
      showToast(setToast, error instanceof Error ? error.message : t("topbar.error.saveProject"));
    });
}

function showToast(setToast: (message: string | undefined) => void, message: string): void {
  setToast(message);
  window.setTimeout(() => setToast(undefined), 2400);
}
