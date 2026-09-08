import { type Dispatch, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { logger } from "../core/logger";
import {
  clearCurrentProjectPath,
  clearRecoverySnapshot,
  loadProjectFromPath,
  openProjectFromSystemPath,
  readNativeRecoverySnapshotForCurrentProject,
  readRecoverySnapshot,
  readRecoverySnapshotForCurrentProject,
  saveProjectDocument,
} from "../core/project/project-file";
import { reportUiError } from "../errors/report-ui-error";
import { useI18n } from "../i18n/react";
import type { EditorAction, EditorState } from "../state/editor-store";
import { isProjectDirty } from "../state/editor-store";
import {
  authorizeRecentProject,
  documentLifecycle,
  getPreferences,
  isDesktopRuntime,
  onProjectOpenAvailable,
  takeNextProjectOpen,
} from "./api";
import type { AppPreferences } from "./preferences";

export interface DocumentLifecycleController {
  dirty: boolean;
  recentProjects: string[];
  refreshPreferences(): Promise<AppPreferences | undefined>;
  save(chooseDirectory?: boolean): Promise<string | undefined>;
  guardReplacement(): Promise<boolean>;
  openRecent(path: string): Promise<boolean>;
}

export function useDocumentLifecycle(
  state: EditorState,
  dispatch: Dispatch<EditorAction>,
): DocumentLifecycleController {
  const { t } = useI18n();
  const latestState = useRef(state);
  const startupProjectId = useRef(state.project.id);
  const handlingSystemRequest = useRef(false);
  const saveInFlight = useRef<Promise<string | undefined> | undefined>(undefined);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const dirty = isProjectDirty(state);
  latestState.current = state;

  const refreshPreferences = useCallback(async () => {
    if (!isDesktopRuntime()) return undefined;
    try {
      const preferences = await getPreferences();
      setRecentProjects(preferences.recentProjects);
      return preferences;
    } catch (error) {
      logger.warn("preferences", "read_failed", undefined, error);
      return undefined;
    }
  }, []);

  const save = useCallback(
    (chooseDirectory = false) => {
      if (saveInFlight.current) return saveInFlight.current;
      const candidate = latestState.current;
      const request = saveProjectDocument(candidate.project, chooseDirectory)
        .then(async (path) => {
          if (!path) return undefined;
          dispatch({
            type: "markSaved",
            projectId: candidate.project.id,
            revision: candidate.projectRevision,
          });
          await refreshPreferences();
          return path;
        })
        .finally(() => {
          saveInFlight.current = undefined;
        });
      saveInFlight.current = request;
      return request;
    },
    [dispatch, refreshPreferences],
  );

  const guardReplacement = useCallback(async () => {
    if (!isProjectDirty(latestState.current)) return true;
    if (!isDesktopRuntime()) {
      if (!window.confirm("Discard unsaved changes?")) return false;
      await clearRecoverySnapshot();
      return true;
    }
    const current = latestState.current;
    const decision = await documentLifecycle().confirmReplace({
      dirty: isProjectDirty(current),
      projectName: current.project.name,
    });
    if (decision === "cancel") return false;
    if (decision === "save") return Boolean(await save());
    await clearRecoverySnapshot();
    return true;
  }, [save]);

  const applySystemRequest = useCallback(async () => {
    if (!isDesktopRuntime() || handlingSystemRequest.current) return;
    handlingSystemRequest.current = true;
    let handledRequest = false;
    try {
      const request = await takeNextProjectOpen();
      if (!request) return;
      handledRequest = true;
      if (!request.path && !(await guardReplacement())) return;
      const selected = request.path
        ? await openProjectFromSystemPath(request.path, guardReplacement)
        : undefined;
      if (request.path && !selected) return;
      const recovery = request.recoverAutosave
        ? await readRecoverySnapshotForCurrentProject()
        : undefined;
      if (recovery) {
        dispatch({ type: "loadProject", project: recovery, markSaved: false });
        logger.info("project", "system_recovery_loaded", {
          sourcePath: request.path ? "project" : "browser_snapshot",
        });
      } else if (selected) {
        dispatch({ type: "loadProject", project: selected.project, markSaved: true });
      }
      await refreshPreferences();
    } catch (error) {
      reportUiError(t, "projectOpen", error, {
        scope: { area: "project", projectId: latestState.current.project.id },
      });
    } finally {
      handlingSystemRequest.current = false;
      if (handledRequest) window.setTimeout(() => void applySystemRequest(), 0);
    }
  }, [dispatch, guardReplacement, refreshPreferences, t]);

  const openRecent = useCallback(
    async (path: string) => {
      if (!isDesktopRuntime() || !(await authorizeRecentProject(path))) {
        await refreshPreferences();
        return false;
      }
      try {
        const selected = await openProjectFromSystemPath(path, guardReplacement);
        if (!selected) return false;
        dispatch({ type: "loadProject", project: selected.project, markSaved: true });
        await refreshPreferences();
        return true;
      } catch (error) {
        reportUiError(t, "projectOpen", error, {
          scope: { area: "project", projectId: latestState.current.project.id },
        });
        return false;
      }
    },
    [dispatch, guardReplacement, refreshPreferences, t],
  );

  useEffect(() => {
    void refreshPreferences();
  }, [refreshPreferences]);

  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const current = latestState.current;
        if (
          handlingSystemRequest.current ||
          current.project.id !== startupProjectId.current ||
          isProjectDirty(current)
        )
          return;
        handlingSystemRequest.current = true;
        let nativeContext = false;
        try {
          let recovery = await readRecoverySnapshot();
          if (isDesktopRuntime()) {
            const preferences = await getPreferences();
            const path = preferences.lastProjectPath;
            if (path && (await authorizeRecentProject(path))) {
              const base = await loadProjectFromPath(path);
              nativeContext = true;
              const nativeRecovery = await readNativeRecoverySnapshotForCurrentProject();
              if (nativeRecovery && nativeRecovery.id !== base.project.id)
                logger.warn("project", "native_recovery_project_mismatch");
              if (nativeRecovery?.id === base.project.id) recovery = nativeRecovery;
              nativeContext = recovery?.id === base.project.id;
              if (!nativeContext) clearCurrentProjectPath();
            }
          }
          if (!recovery || disposed) return;
          const accepted = isDesktopRuntime()
            ? await documentLifecycle().confirmRecovery(recovery.name)
            : window.confirm(`Recover autosaved project “${recovery.name}”?`);
          if (
            disposed ||
            latestState.current.project.id !== startupProjectId.current ||
            isProjectDirty(latestState.current)
          ) {
            if (nativeContext) clearCurrentProjectPath();
            return;
          }
          if (!accepted) {
            await clearRecoverySnapshot();
            if (nativeContext) clearCurrentProjectPath();
            return;
          }
          dispatch({ type: "loadProject", project: recovery, markSaved: false });
        } catch (error) {
          if (nativeContext) clearCurrentProjectPath();
          reportUiError(t, "projectRecovery", error, {
            scope: { area: "project", projectId: latestState.current.project.id },
          });
        } finally {
          handlingSystemRequest.current = false;
          if (!disposed) void applySystemRequest();
        }
      })();
    }, 500);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [applySystemRequest, dispatch, t]);

  useLayoutEffect(() => {
    if (!isDesktopRuntime()) return;
    documentLifecycle().updateState({
      dirty,
      projectName: state.project.name,
    });
  }, [dirty, state.project.name]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const removeCloseListener = documentLifecycle().onCloseRequested((action) => {
      if (action === "discard") {
        void clearRecoverySnapshot()
          .then(() => documentLifecycle().confirmClose())
          .catch((error: unknown) => {
            reportUiError(t, "projectRecovery", error, {
              scope: { area: "project", projectId: latestState.current.project.id },
            });
          });
        return;
      }
      void save()
        .then((path) => {
          if (path) return documentLifecycle().confirmClose();
          return undefined;
        })
        .catch((error: unknown) => {
          reportUiError(t, "projectSave", error, {
            scope: { area: "project", projectId: latestState.current.project.id },
          });
        });
    });
    const removeProjectListener = onProjectOpenAvailable(() => void applySystemRequest());
    void applySystemRequest();
    return () => {
      removeCloseListener();
      removeProjectListener();
    };
  }, [applySystemRequest, save, t]);

  return {
    dirty,
    recentProjects,
    refreshPreferences,
    save,
    guardReplacement,
    openRecent,
  };
}
