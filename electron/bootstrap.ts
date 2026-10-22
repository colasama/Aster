// Keep the packaged retained-raster worker out of the editor's startup and IPC lifecycle.
if (process.env.ASTER_NATIVE_RASTER_CONNECT) await import("./native-raster-host.js");
else await import("./main.js");

export {};
