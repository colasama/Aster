import { useEffect } from "react";
import { Inspector } from "./components/Inspector";
import { Profiler } from "./components/Profiler";
import { ProjectPanel } from "./components/ProjectPanel";
import { Timeline } from "./components/Timeline";
import { TopBar } from "./components/TopBar";
import { Viewport } from "./components/Viewport";
import { activeComposition } from "./core/project";
import { EditorProvider, useEditor } from "./state/editor-store";
import "./styles/index.css";

function Studio() {
  const { state, dispatch } = useEditor();
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
          <i className="status-dot" /> Ready
        </span>
        <span>Linear sRGB · 32 bpc float</span>
        <span>GPU memory budget: Auto</span>
        <span className="status-spacer" />
        <span>Aster 0.2.0 · M0/M1 vertical slice</span>
      </footer>
    </main>
  );
}

export default function App() {
  return (
    <EditorProvider>
      <Studio />
    </EditorProvider>
  );
}
