import { useI18n } from "../../i18n/react";
import { Profiler } from "../diagnostics/Profiler";
import { Panel } from "../Panel";
import { Timeline } from "../timeline/Timeline";

export function WorkspaceTimelineSurface({ mode }: { readonly mode: "timeline" | "graph" }) {
  return <Timeline mode={mode} />;
}

export function WorkspaceProfilerSurface() {
  const { t } = useI18n();
  return (
    <Panel className="workspace-profiler-panel" title={t("workspace.panel.profiler")}>
      <Profiler />
    </Panel>
  );
}
