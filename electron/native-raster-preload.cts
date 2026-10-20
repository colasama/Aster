import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "asterDesktop",
  Object.freeze({
    invoke: (command: string, args: Record<string, unknown> = {}) =>
      ipcRenderer.invoke("aster:native-raster-desktop", command, args),
    convertFileSrc: (path: string) => `aster-asset://local/${encodeURIComponent(path)}`,
    log: (entry: Record<string, unknown>) => ipcRenderer.send("aster:native-raster-log", entry),
  }),
);
contextBridge.exposeInMainWorld(
  "asterRasterService",
  Object.freeze(
    Object.fromEntries(
      ["open", "ready", "take", "frame", "fail"].map((name) => [
        name,
        (value?: unknown) => ipcRenderer.invoke(`aster:native-raster-${name}`, value),
      ]),
    ),
  ),
);
