import { useEffect } from "react";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { Panel } from "../Panel";
import { Profiler } from "../Profiler";
import { Timeline } from "../Timeline";

export function WorkspaceTimelineSurface({ mode }: { readonly mode: "timeline" | "graph" }) {
  const { state, dispatch } = useEditor();
  useEffect(() => {
    if (state.bottomMode !== mode) dispatch({ type: "setBottomMode", mode });
  }, [dispatch, mode, state.bottomMode]);
  return <Timeline />;
}

export function WorkspaceProfilerSurface() {
  const { t } = useI18n();
  return (
    <Panel className="workspace-profiler-panel" title={t("workspace.panel.profiler")}>
      <Profiler />
    </Panel>
  );
}
