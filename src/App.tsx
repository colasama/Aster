import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { AutomationConnection } from "./ai/AutomationConnection";
import { DiagnosticBanner } from "./components/diagnostics/DiagnosticBanner";
import {
  ApplicationDiagnosticBoundary,
  DiagnosticRuntimeMonitor,
} from "./components/diagnostics/DiagnosticBoundary";
import { Inspector } from "./components/inspector/Inspector";
import { ProjectPanel } from "./components/project/ProjectPanel";
import { TopBar } from "./components/shell/TopBar";
import { usePlayback } from "./components/timeline/use-timeline-playback";
import { Viewport } from "./components/viewport/Viewport";
import { DockWorkspace } from "./components/workspace/DockWorkspace";
import {
  WorkspaceProfilerSurface,
  WorkspaceTimelineSurface,
} from "./components/workspace/WorkspacePanelSurfaces";
import type { WorkspacePanelDefinition } from "./components/workspace/workspace-types";
import { activeComposition } from "./core/project/project";
import { projectPluginReferences } from "./core/project/project-plugin-references";
import { reportUiError } from "./errors/report-ui-error";
import { I18nProvider, useI18n } from "./i18n/react";
import { EditorProvider, useEditor } from "./state/editor-store";
import { isEditableShortcutTarget, isEditorShortcutBlocked } from "./ui/keyboard-shortcuts";
import "./styles/index.css";

const RenderQueuePanel = lazy(() =>
  import("./components/render-queue/RenderQueuePanel").then((module) => ({
    default: module.RenderQueuePanel,
  })),
);

function Studio() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  usePlayback(composition, composition.workArea);
  const referencedPluginIds = useMemo(
    () => projectPluginReferences(state.project),
    [state.project],
  );
  const referencedPluginKey = referencedPluginIds.join("\u0000");
  const projectPluginRuntimeWasRequested = useRef(false);
  const workspacePanels = useMemo<readonly WorkspacePanelDefinition[]>(
    () => [
      { id: "project", label: t("workspace.panel.project"), element: <ProjectPanel /> },
      {
        id: "viewport",
        label: t("workspace.panel.viewport"),
        element: <Viewport />,
        viewerType: "composition",
      },
      { id: "inspector", label: t("workspace.panel.inspector"), element: <Inspector /> },
      {
        id: "timeline",
        label: t("workspace.panel.timeline"),
        element: <WorkspaceTimelineSurface mode="timeline" />,
      },
      {
        id: "graph",
        label: t("workspace.panel.graph"),
        element: <WorkspaceTimelineSurface mode="graph" />,
      },
      {
        id: "profiler",
        label: t("workspace.panel.profiler"),
        element: <WorkspaceProfilerSurface />,
      },
      {
        id: "renderQueue",
        label: t("renderQueue.panelTitle"),
        element: (
          <Suspense fallback={null}>
            <RenderQueuePanel />
          </Suspense>
        ),
      },
    ],
    [t],
  );
  useEffect(() => {
    if (!referencedPluginKey && !projectPluginRuntimeWasRequested.current) return;
    const pluginIds = referencedPluginKey ? referencedPluginKey.split("\u0000") : [];
    projectPluginRuntimeWasRequested.current = pluginIds.length > 0;
    let active = true;
    void import("./core/plugins/plugin-runtime")
      .then(({ setProjectPluginRuntimes }) =>
        active ? setProjectPluginRuntimes(pluginIds) : undefined,
      )
      .catch((error: unknown) =>
        reportUiError(t, "pluginOperation", error, {
          scope: { area: "project", projectId: state.project.id },
        }),
      );
    return () => {
      active = false;
    };
  }, [referencedPluginKey, state.project.id, t]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditorShortcutBlocked(event) || isEditableShortcutTarget(event.target)) return;
      if (
        event.code === "Space" &&
        !(event.target as HTMLElement)?.closest?.("button, [role=tab]") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        dispatch({ type: "setPlaying", playing: !state.playing });
      } else if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
      } else if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        dispatch({ type: "redo" });
      } else if (
        event.key === "Delete" &&
        state.selection.length > 0 &&
        state.selectedKeyframes.length === 0
      ) {
        const composition = activeComposition(state.project);
        if (
          composition.layers.length > state.selection.length &&
          state.selection.every((id) =>
            composition.layers.some((layer) => layer.id === id && !layer.locked),
          )
        ) {
          dispatch({
            type: "operation",
            operations: state.selection.map((layerId) => ({ type: "removeLayer", layerId })),
            select: [],
          });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, state.playing, state.project, state.selection, state.selectedKeyframes.length]);
  return (
    <main className="aster-studio">
      <TopBar />
      <DockWorkspace panels={workspacePanels} viewerContextId={state.project.activeCompositionId} />
      <footer className="status-bar">
        <span>
          <i className="status-dot" /> {t("app.status.ready")}
        </span>
        <span>{t("app.status.color")}</span>
        <span>
          {t("app.status.gpuBudget", {
            value:
              state.gpuMemoryBudgetMb === "auto"
                ? t("app.status.gpuBudgetAuto")
                : `${state.gpuMemoryBudgetMb} MB`,
          })}
        </span>
        <span className="status-spacer" />
        <span>{t("app.status.version")}</span>
      </footer>
    </main>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <EditorProvider>
        <AutomationConnection />
        <DiagnosticRuntimeMonitor />
        <ApplicationDiagnosticBoundary>
          <Studio />
        </ApplicationDiagnosticBoundary>
        <DiagnosticBanner />
      </EditorProvider>
    </I18nProvider>
  );
}
