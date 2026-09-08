import { useI18n } from "../../i18n/react";
import { Panel } from "../Panel";
import { Profiler } from "../Profiler";
import { Timeline } from "../Timeline";

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
