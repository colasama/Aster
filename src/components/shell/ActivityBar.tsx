import {
  Activity,
  FolderOpen,
  ListVideo,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useI18n } from "../../i18n/react";
import { useWorkspaceController } from "../../workspace/workspace-controller";

const WorkspaceDialog = lazy(() =>
  import("../settings/WorkspaceDialog").then((module) => ({ default: module.WorkspaceDialog })),
);

/** One button per dockable panel: it brings the panel to the front wherever it is docked. */
const ACTIVITY_PANELS = [
  { panel: "project", icon: FolderOpen },
  { panel: "effects", icon: WandSparkles },
  { panel: "inspector", icon: SlidersHorizontal },
  { panel: "ai", icon: Sparkles },
  { panel: "renderQueue", icon: ListVideo },
  { panel: "profiler", icon: Activity },
] as const;

export function ActivityBar() {
  const { t } = useI18n();
  const workspace = useWorkspaceController();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  return (
    <>
      <nav className="activity-bar" aria-label={t("app.navigation")}>
        {ACTIVITY_PANELS.map(({ panel, icon: Icon }) => {
          const summary = workspace?.panels.find((candidate) => candidate.id === panel);
          if (workspace && !summary) return null;
          const label = summary?.label ?? panel;
          return (
            <button
              key={panel}
              type="button"
              aria-label={label}
              aria-pressed={Boolean(summary?.visible && summary.active)}
              title={label}
              disabled={!workspace}
              onClick={() => workspace?.setPanelVisible(panel, true)}
            >
              <Icon size={20} strokeWidth={1.6} />
            </button>
          );
        })}
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
