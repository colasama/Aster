import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    getPreferences: () => ipcRenderer.invoke("aster:preferences-get"),
    getGpuMemoryDevices: () => ipcRenderer.invoke("aster:gpu-memory-devices"),
    // Exports only need validated shader payloads for the plugins their project references.
    invoke: (command: string, args: Record<string, unknown> = {}) =>
      command === "load_plugin_runtime"
        ? ipcRenderer.invoke("aster:invoke", command, args)
        : Promise.reject(new Error(`Render host cannot invoke ${command}`)),
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
