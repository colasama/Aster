import { useI18n } from "../../i18n/react";
import { Panel } from "../Panel";
import { AiPanel } from "./AiPanel";

export function AiAssistantPanel() {
  const { t } = useI18n();
  return (
    <Panel className="inspector-panel ai-assistant-panel" title={t("workspace.panel.ai")}>
      <AiPanel />
    </Panel>
  );
}
