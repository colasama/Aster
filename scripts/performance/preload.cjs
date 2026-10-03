const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    invoke: (command, args = {}) => ipcRenderer.invoke("aster:performance-desktop", command, args),
    convertFileSrc: (path) => `aster-asset://local/${encodeURIComponent(path)}`,
    getPreferences: () => ipcRenderer.invoke("aster:performance-preferences"),
    getGpuMemoryDevices: () => ipcRenderer.invoke("aster:performance-gpu-memory"),
    log: (entry) => ipcRenderer.send("aster:performance-log", entry),
  }),
);

contextBridge.exposeInMainWorld(
  "asterPerformance",
  Object.freeze({
    ready: (identity) => ipcRenderer.invoke("aster:performance-ready", identity),
    take: () => ipcRenderer.invoke("aster:performance-take"),
    output: (request) => ipcRenderer.invoke("aster:performance-output", request),
    complete: (result) => ipcRenderer.invoke("aster:performance-complete", result),
    fail: (failure) => ipcRenderer.invoke("aster:performance-fail", failure),
    done: () => ipcRenderer.invoke("aster:performance-done"),
  }),
);
