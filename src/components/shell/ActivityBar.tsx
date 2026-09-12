import {
  FolderOpen,
  ListVideo,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useWorkspaceController } from "../../workspace/workspace-controller";

const WorkspaceDialog = lazy(() =>
  import("../settings/WorkspaceDialog").then((module) => ({ default: module.WorkspaceDialog })),
);

export function ActivityBar() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const workspace = useWorkspaceController();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const panelActive = (id: string) =>
    workspace?.panels.some((panel) => panel.id === id && panel.active);
  const items = [
    {
      id: "project",
      panel: "project",
      label: t("project.tab.project"),
      icon: FolderOpen,
      active: panelActive("project") && state.leftTab === "project",
      select: () => dispatch({ type: "setLeftTab", tab: "project" }),
    },
    {
      id: "effects",
      panel: "project",
      label: t("project.tab.effects"),
      icon: WandSparkles,
      active: panelActive("project") && state.leftTab === "effects",
      select: () => dispatch({ type: "setLeftTab", tab: "effects" }),
    },
    {
      id: "properties",
      panel: "inspector",
      label: t("inspector.tab.properties"),
      icon: SlidersHorizontal,
      active: panelActive("inspector") && state.rightTab === "properties",
      select: () => dispatch({ type: "setRightTab", tab: "properties" }),
    },
    {
      id: "ai",
      panel: "inspector",
      label: t("inspector.tab.ai"),
      icon: Sparkles,
      active: panelActive("inspector") && state.rightTab === "ai",
      select: () => dispatch({ type: "setRightTab", tab: "ai" }),
    },
    {
      id: "renderQueue",
      panel: "renderQueue",
      label: t("renderQueue.panelTitle"),
      icon: ListVideo,
      active: panelActive("renderQueue"),
    },
  ];
  return (
    <>
      <nav className="activity-bar" aria-label={t("app.navigation")}>
        {items.map(({ id, panel, label, icon: Icon, active, select }) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={Boolean(active)}
            title={label}
            disabled={!workspace}
            onClick={() => {
              select?.();
              workspace?.setPanelVisible(panel, true);
            }}
          >
            <Icon size={20} strokeWidth={1.6} />
          </button>
        ))}
        <button
          className="activity-settings"
          type="button"
          aria-label={t("topbar.item.preferences")}
          title={t("topbar.item.preferences")}
          onClick={() => setPreferencesOpen(true)}
        >
          <Settings2 size={20} strokeWidth={1.6} />
        </button>
      </nav>
      {preferencesOpen && (
        <Suspense fallback={null}>
          <WorkspaceDialog kind="preferences" onClose={() => setPreferencesOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
