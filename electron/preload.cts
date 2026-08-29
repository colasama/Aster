import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    invoke: (command: string, args: Record<string, unknown> = {}) =>
      ipcRenderer.invoke("aster:invoke", command, args),
    runAgent: (request: Record<string, unknown>) => ipcRenderer.invoke("aster:agent-run", request),
    respondAgentTool: (response: Record<string, unknown>) =>
      ipcRenderer.invoke("aster:agent-tool-response", response),
    cancelAgent: (sessionId: string) => ipcRenderer.invoke("aster:agent-cancel", sessionId),
    onAgentEvent: (listener: (event: unknown) => void) => {
      const handleAgentEvent = (_event: IpcRendererEvent, value: unknown) => listener(value);
      ipcRenderer.on("aster:agent-event", handleAgentEvent);
      return () => ipcRenderer.removeListener("aster:agent-event", handleAgentEvent);
    },
    activateFullAccess: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("aster:full-access-activate", request),
    revokeFullAccess: (grantId: string) => ipcRenderer.invoke("aster:full-access-revoke", grantId),
    emergencyStopAgent: (sessionId: string, grantId?: string) =>
      ipcRenderer.invoke("aster:agent-emergency-stop", sessionId, grantId),
    open: (options: Record<string, unknown>) => ipcRenderer.invoke("aster:open", options),
    save: (options: Record<string, unknown>) => ipcRenderer.invoke("aster:save", options),
    convertFileSrc: (path: string) => `aster-asset://local/${encodeURIComponent(path)}`,
    getPreferences: () => ipcRenderer.invoke("aster:preferences-get"),
    updatePreferences: (preferences: Record<string, unknown>) =>
      ipcRenderer.invoke("aster:preferences-update", preferences),
    migrateLegacyPreferences: (preferences: Record<string, unknown>) =>
      ipcRenderer.invoke("aster:preferences-migrate-legacy", preferences),
    authorizeRecentProject: (path: string) =>
      ipcRenderer.invoke("aster:project-authorize-recent", path),
    rememberProject: (path: string) => ipcRenderer.invoke("aster:project-remember", path),
    forgetActiveProject: () => ipcRenderer.invoke("aster:project-forget-active"),
    takeNextProjectOpen: () => ipcRenderer.invoke("aster:project-open-take"),
    onProjectOpenAvailable: (listener: () => void) => {
      const handleProjectOpen = () => listener();
      ipcRenderer.on("aster:project-open-available", handleProjectOpen);
      return () => ipcRenderer.removeListener("aster:project-open-available", handleProjectOpen);
    },
    documentLifecycle: Object.freeze({
      updateState: (state: Record<string, unknown>) =>
        ipcRenderer.send("aster:document-state", state),
      confirmReplace: (state: Record<string, unknown>) =>
        ipcRenderer.invoke("aster:document-confirm-replace", state),
      confirmClose: () => ipcRenderer.invoke("aster:document-confirm-close"),
      confirmRecovery: (projectName: string) =>
        ipcRenderer.invoke("aster:document-confirm-recovery", projectName),
      onCloseRequested: (listener: (action: "save" | "discard") => void) => {
        const handleCloseRequested = (_event: IpcRendererEvent, action: "save" | "discard") =>
          listener(action);
        ipcRenderer.on("aster:close-requested", handleCloseRequested);
        return () => ipcRenderer.removeListener("aster:close-requested", handleCloseRequested);
      },
    }),
    exportDiagnostics: () => ipcRenderer.invoke("aster:diagnostics-export"),
    startMp4Export: (options: Record<string, unknown>) =>
      ipcRenderer.invoke("aster:mp4-start", options),
    writeMp4Frame: (jobId: string, pixels: ArrayBuffer) =>
      ipcRenderer.invoke("aster:mp4-frame", jobId, pixels),
    finishMp4Export: (jobId: string) => ipcRenderer.invoke("aster:mp4-finish", jobId),
    cancelMp4Export: (jobId: string) => ipcRenderer.invoke("aster:mp4-cancel", jobId),
    log: (entry: Record<string, unknown>) => ipcRenderer.send("aster:log", entry),
    windowControls: Object.freeze({
      platform: process.platform,
      minimize: () => ipcRenderer.invoke("aster:window-minimize"),
      toggleMaximize: () => ipcRenderer.invoke("aster:window-toggle-maximize"),
      isMaximized: () => ipcRenderer.invoke("aster:window-is-maximized"),
      close: () => ipcRenderer.invoke("aster:window-close"),
      onMaximizedChange: (listener: (maximized: boolean) => void) => {
        const handleMaximizedChange = (_event: IpcRendererEvent, maximized: boolean) => {
          listener(maximized);
        };
        ipcRenderer.on("aster:window-maximized", handleMaximizedChange);
        return () => ipcRenderer.removeListener("aster:window-maximized", handleMaximizedChange);
      },
    }),
  }),
);
