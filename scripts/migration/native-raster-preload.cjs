const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    invoke: (command, args = {}) => ipcRenderer.invoke("aster:raster-desktop", command, args),
    convertFileSrc: (path) => `aster-asset://local/${encodeURIComponent(path)}`,
    log: (entry) => ipcRenderer.send("aster:raster-log", entry),
  }),
);
contextBridge.exposeInMainWorld(
  "asterNativeRaster",
  Object.freeze(
    Object.fromEntries(
      ["take", "ready", "prepare", "frame", "done", "fail"].map((name) => [
        name,
        (value) => ipcRenderer.invoke(`aster:raster-${name}`, value),
      ]),
    ),
  ),
);
