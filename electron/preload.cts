import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    invoke: (command: string, args: Record<string, unknown> = {}) =>
      ipcRenderer.invoke("aster:invoke", command, args),
    open: (options: Record<string, unknown>) => ipcRenderer.invoke("aster:open", options),
    save: (options: Record<string, unknown>) => ipcRenderer.invoke("aster:save", options),
    convertFileSrc: (path: string) => `aster-asset://local/${encodeURIComponent(path)}`,
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
