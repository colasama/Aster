import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    renderHost: Object.freeze({
      take: () => ipcRenderer.invoke("aster:render-host-take"),
      output: (request: Record<string, unknown>) =>
        ipcRenderer.invoke("aster:render-host-output", request),
      report: (report: Record<string, unknown>) =>
        ipcRenderer.invoke("aster:render-host-report", report),
      onControl: (listener: (control: unknown) => void) => {
        const handleControl = (_event: IpcRendererEvent, control: unknown) => listener(control);
        ipcRenderer.on("aster:render-host-control", handleControl);
        return () => ipcRenderer.removeListener("aster:render-host-control", handleControl);
      },
    }),
    log: (entry: Record<string, unknown>) => ipcRenderer.send("aster:log", entry),
  }),
);
