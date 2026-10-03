const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    invoke: (command, args = {}) => ipcRenderer.invoke("aster:parity-desktop", command, args),
    convertFileSrc: (path) => `aster-asset://local/${encodeURIComponent(path)}`,
    getPreferences: () => ipcRenderer.invoke("aster:parity-preferences"),
    getGpuMemoryDevices: () => ipcRenderer.invoke("aster:parity-gpu-memory"),
    log: (entry) => ipcRenderer.send("aster:parity-log", entry),
  }),
);

contextBridge.exposeInMainWorld(
  "asterParity",
  Object.freeze({
    ready: (identity) => ipcRenderer.invoke("aster:parity-ready", identity),
    take: () => ipcRenderer.invoke("aster:parity-take"),
    frame: (payload) => ipcRenderer.invoke("aster:parity-frame", payload),
    completeCase: (payload) => ipcRenderer.invoke("aster:parity-complete", payload),
    fail: (payload) => ipcRenderer.invoke("aster:parity-fail", payload),
    done: () => ipcRenderer.invoke("aster:parity-done"),
  }),
);
