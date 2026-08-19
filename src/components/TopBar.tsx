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
import { createLayerForComposition } from "../core/layer-factory";
import { getProperty } from "../core/operations";
import { precomposeLayers } from "../core/precomposition";
import { activeComposition, createBlankComposition, createBlankProject } from "../core/project";
import {
  clearRecoverySnapshot,
  downloadBlob,
  pickProjectFile,
  readRecoverySnapshotForCurrentProject,
  saveProjectDocument,
} from "../core/project-file";
import { evaluateAnimatable } from "../core/timeline";
import { createId, type LayerKind, type Project } from "../core/types";
import { createEffect } from "../effects/registry";
import { useEditor } from "../state/editor-store";
import { WorkspaceDialog, type WorkspaceDialogKind } from "./WorkspaceDialog";

const menus = [
  "File",
  "Edit",
  "Composition",
  "Layer",
  "Effect",
  "Animation",
  "View",
  "Window",
  "Help",
];

const menuItems: Record<string, string[]> = {
  File: ["New Project", "Open…", "Recover Autosave", "Save Project", "Save As…", "Export Frame…"],
  Edit: ["Undo", "Redo", "Duplicate", "Preferences…"],
  Composition: ["New Composition", "Composition Settings…", "Add to Render Queue"],
  Layer: [
    "Import Image…",
    "Import Video…",
    "New Text Layer",
    "New Shape Layer",
    "New Camera",
    "Pre-compose…",
  ],
  Effect: ["Glow / Bloom", "Kawase Blur", "Color Matrix", "Looks Color Lab"],
  Animation: ["Add Keyframe", "Graph Editor", "Easy Ease", "Expression Editor"],
  View: ["Fit Composition", "Zoom In", "Zoom Out", "Toggle Guides"],
  Window: ["Project", "Viewport", "Timeline", "Properties", "AI Operator"],
  Help: ["Command Palette", "Keyboard Shortcuts", "GPU Diagnostics", "About Aster"],
};

interface ToolDefinition {
  id: string;
  icon: ComponentType<{ size?: number }>;
  label: string;
}

const tools: ToolDefinition[] = [
  { id: "select", icon: MousePointer2, label: "Selection tool (V)" },
  { id: "hand", icon: Hand, label: "Hand tool (H)" },
  { id: "rotate", icon: RotateCcw, label: "Rotation tool (W)" },
  { id: "shape", icon: Square, label: "Rectangle tool (Q)" },
  { id: "ellipse", icon: Circle, label: "Ellipse tool" },
  { id: "pen", icon: PenTool, label: "Pen tool (G)" },
  { id: "text", icon: Type, label: "Text tool (T)" },
  { id: "3d", icon: Box, label: "3D gizmo" },
];

export function TopBar() {
  const { state, dispatch } = useEditor();
  const [activeMenu, setActiveMenu] = useState<string>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderFormat, setRenderFormat] = useState<"png" | "project">("png");
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogKind>();
  const [toast, setToast] = useState<string>();
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(
    () => [
      { label: "Save project", action: () => saveProject(state.project, setToast) },
      {
        label: "Open Graph Editor",
        action: () => dispatch({ type: "setBottomMode", mode: "graph" }),
      },
      { label: "Open AI Operator", action: () => dispatch({ type: "setRightTab", tab: "ai" }) },
      {
        label: "Fit composition at 22%",
        action: () => dispatch({ type: "setViewportZoom", zoom: 0.22 }),
      },
      {
        label: state.playing ? "Pause preview" : "Play preview",
        action: () => dispatch({ type: "setPlaying", playing: !state.playing }),
      },
      { label: "Render current frame", action: () => setRenderOpen(true) },
    ],
    [dispatch, state.playing, state.project],
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
        saveProject(state.project, setToast);
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
  }, [dispatch, state.project]);
  useEffect(() => {
    if (paletteOpen) paletteInputRef.current?.focus();
  }, [paletteOpen]);
  const handleMenuItem = (item: string) => {
    setActiveMenu(undefined);
    const composition = activeComposition(state.project);
    const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
    const layerTypes: Record<string, LayerKind> = {
      "New Text Layer": "text",
      "New Shape Layer": "shape",
      "New Camera": "camera",
    };
    const effectTypes: Record<string, string> = {
      "Glow / Bloom": "glow",
      "Kawase Blur": "kawase-blur",
      "Color Matrix": "color-matrix",
      "Looks Color Lab": "looks-color-lab",
    };
    if (item === "New Project") {
      clearRecoverySnapshot();
      dispatch({ type: "loadProject", project: createBlankProject() });
    } else if (item === "Open…") openProjectFile(dispatch, setToast);
    else if (item === "Recover Autosave") {
      void readRecoverySnapshotForCurrentProject()
        .then((recovery) => {
          if (recovery) {
            dispatch({ type: "loadProject", project: recovery });
            showToast(setToast, "Recovered the latest valid autosave");
          } else showToast(setToast, "No valid autosave is available");
        })
        .catch((error: unknown) =>
          showToast(setToast, error instanceof Error ? error.message : "Recovery failed"),
        );
    } else if (item === "Save Project" || item === "Save As…")
      saveProject(state.project, setToast, item === "Save As…");
    else if (item === "Undo") dispatch({ type: "undo" });
    else if (item === "Redo") dispatch({ type: "redo" });
    else if (item === "Duplicate" && selectedLayer) {
      const duplicate = structuredClone(selectedLayer);
      duplicate.id = createId();
      duplicate.name = `${duplicate.name} Copy`;
      duplicate.effects.forEach((effect) => {
        effect.id = createId();
      });
      dispatch({
        type: "operation",
        operations: [{ type: "addLayer", layer: duplicate }],
        select: [duplicate.id],
      });
    } else if (item === "New Composition") {
      const project = structuredClone(state.project);
      const next = createBlankComposition(`Composition ${project.compositions.length + 1}`);
      project.compositions.push(next);
      project.activeCompositionId = next.id;
      dispatch({ type: "commitProject", project, select: [] });
    } else if (item === "Pre-compose…" && state.selection.length > 0) {
      const result = precomposeLayers(state.project, state.selection);
      if (!result) {
        showToast(setToast, "Select at least one valid layer to pre-compose");
        return;
      }
      dispatch({ type: "commitProject", project: result.project, select: [result.wrapperId] });
      const nested = result.project.compositions.find(
        (composition) => composition.id === result.nestedCompositionId,
      );
      showToast(setToast, `Created ${nested?.name ?? "precomposition"}`);
    } else if (item === "Import Image…" || item === "Import Video…") {
      const kind = item === "Import Image…" ? "image" : "video";
      void importMediaLayer(kind, composition, state.currentTime)
        .then((layer) => {
          if (!layer) return;
          dispatch({
            type: "operation",
            operations: [{ type: "addLayer", layer }],
            select: [layer.id],
          });
          showToast(setToast, `Imported ${layer.asset?.name ?? layer.name}`);
        })
        .catch((error: unknown) =>
          showToast(setToast, error instanceof Error ? error.message : "Asset import failed"),
        );
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
    } else if (item === "Add Keyframe" && selectedLayer) {
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
    } else if (item === "Graph Editor") dispatch({ type: "setBottomMode", mode: "graph" });
    else if (item === "Easy Ease" && selectedLayer) {
      dispatch({
        type: "operation",
        operations: [{ type: "easeLayer", layerId: selectedLayer.id }],
      });
      showToast(setToast, `Applied Easy Ease to ${selectedLayer.name}`);
    } else if (item === "Expression Editor") setWorkspaceDialog("expression");
    else if (item === "Preferences…") setWorkspaceDialog("preferences");
    else if (item === "Composition Settings…") setWorkspaceDialog("composition");
    else if (item === "Keyboard Shortcuts") setWorkspaceDialog("shortcuts");
    else if (item === "About Aster") setWorkspaceDialog("about");
    else if (item === "AI Operator") dispatch({ type: "setRightTab", tab: "ai" });
    else if (item === "Fit Composition" || item === "Viewport")
      dispatch({ type: "setViewportZoom", zoom: 0.22 });
    else if (item === "Zoom In")
      dispatch({ type: "setViewportZoom", zoom: state.viewportZoom * 1.15 });
    else if (item === "Zoom Out")
      dispatch({ type: "setViewportZoom", zoom: state.viewportZoom / 1.15 });
    else if (item.includes("Render") || item.includes("Export Frame")) setRenderOpen(true);
    else if (item === "Command Palette") setPaletteOpen(true);
    else if (item === "Toggle Guides") dispatch({ type: "toggleView", view: "guides" });
    else if (item === "Project") dispatch({ type: "setLeftTab", tab: "project" });
    else if (item === "Properties") dispatch({ type: "setRightTab", tab: "properties" });
    else if (item === "Timeline") dispatch({ type: "setBottomMode", mode: "timeline" });
    else if (item === "GPU Diagnostics") {
      setToast(
        `${state.metrics.fps.toFixed(0)} FPS · ${state.metrics.frameMs.toFixed(2)} ms · ${state.metrics.passCount} GPU passes`,
      );
      window.setTimeout(() => setToast(undefined), 2600);
    } else {
      setToast(`${item} is ready for its next workflow step`);
      window.setTimeout(() => setToast(undefined), 1800);
    }
  };
  return (
    <>
      <div className="title-bar">
        <div className="brand-mark">A</div>
        <div className="menu-strip">
          {menus.map((menu) => (
            <div className="menu-root" key={menu}>
              <button
                className={activeMenu === menu ? "active" : ""}
                onClick={() => setActiveMenu(activeMenu === menu ? undefined : menu)}
                type="button"
              >
                {menu}
              </button>
              {activeMenu === menu && (
                <div className="app-menu-popover">
                  {menuItems[menu].map((item) => (
                    <button key={item} onClick={() => handleMenuItem(item)} type="button">
                      <span>{item}</span>
                      {item === "Undo" && <kbd>Ctrl Z</kbd>}
                      {item === "Redo" && <kbd>Ctrl Y</kbd>}
                      {item === "Command Palette" && <kbd>Ctrl K</kbd>}
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
            aria-label="Save project"
            onClick={() => saveProject(state.project, setToast)}
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
          {tools.map(({ id, icon: Icon, label }) => (
            <button
              className={state.activeTool === id ? "active" : ""}
              key={id}
              onClick={() =>
                dispatch({ type: "setActiveTool", tool: id as typeof state.activeTool })
              }
              title={label}
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
          title="Undo"
          type="button"
        >
          <Undo2 size={16} />
        </button>
        <button
          disabled={!state.history.future.length}
          onClick={() => dispatch({ type: "redo" })}
          title="Redo"
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
            title="Cycle preview resolution"
            type="button"
          >
            {state.previewQuality === 1
              ? "Full"
              : state.previewQuality === 0.5
                ? "Half"
                : "Quarter"}{" "}
            <ChevronDown size={12} />
          </button>
          <span className="gpu-badge">
            <Sparkles size={12} /> GPU Preview
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
            <Search size={14} /> Search project
          </button>
          <button className="render-button" onClick={() => setRenderOpen(true)} type="button">
            <Play fill="currentColor" size={13} /> Render
          </button>
        </div>
      </div>
      {paletteOpen && (
        <div className="modal-backdrop">
          <div className="command-palette">
            <button
              aria-label="Close command palette"
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
                placeholder="Type a command…"
                ref={paletteInputRef}
                value={paletteQuery}
              />
            </div>
            <small>QUICK COMMANDS</small>
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
              <strong>Render current frame</strong>
              <button onClick={() => setRenderOpen(false)} type="button">
                <X size={14} />
              </button>
            </header>
            <div className="render-summary">
              <Sparkles size={20} />
              <div>
                <strong>GPU render pipeline</strong>
                <span>4K · Linear sRGB · PNG</span>
              </div>
            </div>
            <label>
              Output format
              <select
                onChange={(event) => setRenderFormat(event.target.value as "png" | "project")}
                value={renderFormat}
              >
                <option value="png">PNG image</option>
                <option value="project">Aster project JSON</option>
              </select>
            </label>
            <footer>
              <button disabled={rendering} onClick={() => setRenderOpen(false)} type="button">
                Cancel
              </button>
              <button
                className="primary"
                disabled={rendering}
                onClick={async () => {
                  setRendering(true);
                  try {
                    if (renderFormat === "project") saveProject(state.project, setToast);
                    else {
                      await exportViewport();
                      showToast(
                        setToast,
                        `Exported ${activeComposition(state.project).width} × ${activeComposition(state.project).height} PNG`,
                      );
                    }
                    setRenderOpen(false);
                  } catch (error) {
                    showToast(
                      setToast,
                      error instanceof Error ? error.message : "Frame export failed",
                    );
                  } finally {
                    setRendering(false);
                  }
                }}
                type="button"
              >
                {rendering ? (
                  <>
                    <LoaderCircle className="spin" size={12} /> Rendering 4K…
                  </>
                ) : (
                  <>
                    <Play size={12} /> Render frame
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
) {
  try {
    const selected = await pickProjectFile();
    if (!selected) return;
    dispatch({ type: "loadProject", project: selected.project });
    showToast(setToast, `Opened ${selected.name}`);
  } catch (error) {
    showToast(setToast, error instanceof Error ? error.message : "Unable to open project");
  }
}

async function exportViewport(): Promise<void> {
  const blob = await new Promise<Blob | undefined>((resolve) => {
    window.dispatchEvent(new CustomEvent("aster:export-frame", { detail: { resolve } }));
  });
  if (!blob) throw new Error("Renderer did not return an export frame");
  downloadBlob(blob, "aster-frame-4k.png");
}

function saveProject(
  project: Project,
  setToast: (message: string | undefined) => void,
  chooseDirectory = false,
): void {
  void saveProjectDocument(project, chooseDirectory)
    .then((path) => {
      if (path) showToast(setToast, `Saved ${path.split(/[\\/]/).pop() || path}`);
    })
    .catch((error: unknown) => {
      showToast(setToast, error instanceof Error ? error.message : "Unable to save project");
    });
}

function showToast(setToast: (message: string | undefined) => void, message: string): void {
  setToast(message);
  window.setTimeout(() => setToast(undefined), 2400);
}
