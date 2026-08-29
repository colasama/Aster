import { type KeyboardEvent, useState } from "react";
import { useI18n } from "../../i18n/react";
import type { BuiltInWorkspaceId } from "../../workspace/named-workspaces";
import { useWorkspaceController } from "../../workspace/workspace-controller";
import { WorkspaceActionDialog, type WorkspaceActionDialogMode } from "./WorkspaceActionDialog";

export function WorkspaceWindowMenu({ onClose }: { readonly onClose: () => void }) {
  const { t } = useI18n();
  const controller = useWorkspaceController();
  const [dialog, setDialog] = useState<WorkspaceActionDialogMode>();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };
  if (!controller) return null;
  const current = controller.currentWorkspace;
  return (
    <div
      aria-label={t("workspace.windowMenu")}
      className="workspace-window-menu"
      onKeyDown={onKeyDown}
      role="menu"
    >
      <div className="app-menu-heading">{t("workspace.workspaces")}</div>
      {controller.catalog.workspaces.map((workspace) => (
        <button
          aria-checked={workspace.id === controller.catalog.currentWorkspaceId}
          key={workspace.id}
          onClick={() => {
            controller.select(workspace.id);
            onClose();
          }}
          role="menuitemradio"
          type="button"
        >
          <span className="workspace-menu-check">
            {workspace.id === controller.catalog.currentWorkspaceId ? "✓" : ""}
          </span>
          <span>{workspace.builtIn ? builtInName(workspace.id, t) : workspace.name}</span>
        </button>
      ))}
      <div className="app-menu-heading">{t("workspace.manage")}</div>
      <button onClick={() => setDialog("saveAs")} role="menuitem" type="button">
        <span>{t("workspace.action.saveAs")}</span>
      </button>
      <button
        disabled={current.builtIn}
        onClick={() => setDialog("rename")}
        role="menuitem"
        type="button"
      >
        <span>{t("workspace.action.rename")}</span>
      </button>
      <button
        className="destructive"
        disabled={current.builtIn}
        onClick={() => setDialog("delete")}
        role="menuitem"
        type="button"
      >
        <span>{t("workspace.action.delete")}</span>
      </button>
      <button
        onClick={() => {
          controller.resetToSavedLayout();
          onClose();
        }}
        role="menuitem"
        type="button"
      >
        <span>{t("workspace.action.reset")}</span>
      </button>
      <button
        disabled={!controller.canUndo}
        onClick={() => {
          controller.undoLayoutChange();
          onClose();
        }}
        role="menuitem"
        type="button"
      >
        <span>{t("workspace.menu.undo")}</span>
        <kbd>Ctrl Alt Z</kbd>
      </button>
      <div className="app-menu-heading">{t("workspace.panels")}</div>
      {controller.panels.map((panel) => (
        <button
          aria-checked={panel.visible}
          key={panel.id}
          onClick={() => {
            controller.setPanelVisible(panel.id, !panel.visible);
            onClose();
          }}
          role="menuitemcheckbox"
          type="button"
        >
          <span className="workspace-menu-check">{panel.visible ? "✓" : ""}</span>
          <span>{panel.label}</span>
        </button>
      ))}
      {dialog ? (
        <WorkspaceActionDialog
          currentName={current.name}
          mode={dialog}
          onClose={() => setDialog(undefined)}
          onSubmit={(name) => {
            if (dialog === "saveAs") controller.saveAs(name);
            else if (dialog === "rename") controller.renameCurrentWorkspace(name);
            else controller.deleteCurrentWorkspace();
            setDialog(undefined);
            onClose();
          }}
        />
      ) : null}
    </div>
  );
}

function builtInName(workspaceId: string, t: ReturnType<typeof useI18n>["t"]): string {
  const id = workspaceId as BuiltInWorkspaceId;
  return id === "animation"
    ? t("workspace.preset.animation")
    : id === "minimal"
      ? t("workspace.preset.minimal")
      : t("workspace.preset.default");
}
