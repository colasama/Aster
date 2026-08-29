import { useEffect, useMemo, useRef } from "react";
import { Inspector } from "./components/Inspector";
import { Profiler } from "./components/Profiler";
import { ProjectPanel } from "./components/ProjectPanel";
import { Timeline } from "./components/Timeline";
import { TopBar } from "./components/TopBar";
import { Viewport } from "./components/Viewport";
import { logger } from "./core/logger";
import { activeComposition } from "./core/project";
import { projectPluginReferences } from "./core/project-plugin-references";
import { I18nProvider, useI18n } from "./i18n/react";
import { EditorProvider, useEditor } from "./state/editor-store";
import "./styles/index.css";

function Studio() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const referencedPluginIds = useMemo(
    () => projectPluginReferences(state.project),
    [state.project],
  );
  const referencedPluginKey = referencedPluginIds.join("\u0000");
  const projectPluginRuntimeWasRequested = useRef(false);
  useEffect(() => {
    if (!referencedPluginKey && !projectPluginRuntimeWasRequested.current) return;
    const pluginIds = referencedPluginKey ? referencedPluginKey.split("\u0000") : [];
    projectPluginRuntimeWasRequested.current = pluginIds.length > 0;
    let active = true;
    void import("./core/plugin-runtime")
      .then(({ setProjectPluginRuntimes }) =>
        active ? setProjectPluginRuntimes(pluginIds) : undefined,
      )
      .catch((error: unknown) => logger.error("plugins", "project_activation_failed", error));
    return () => {
      active = false;
    };
  }, [referencedPluginKey]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        dispatch({ type: "setPlaying", playing: !state.playing });
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatch({ type: "redo" });
      } else if (event.key === "Delete" && state.selection.length > 0) {
        const composition = activeComposition(state.project);
        if (composition.layers.length > state.selection.length) {
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
  }, [dispatch, state.playing, state.project, state.selection]);
  return (
    <main className="aster-studio">
      <TopBar />
      <div className="editor-grid">
        <ProjectPanel />
        <div className="viewport-cell">
          <Viewport />
          <Profiler />
        </div>
        <Inspector />
        <Timeline />
      </div>
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
        <Studio />
      </EditorProvider>
    </I18nProvider>
  );
}
