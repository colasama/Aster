const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("enable-unsafe-webgpu");
process.env.ASTER_BUNDLED_DEV = "0";
app.on("window-all-closed", () => {});

async function main() {
  await app.whenReady();
  const { createServer } = await import("vite");
  const server = await createServer({
    root: path.resolve(__dirname, ".."),
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  });
  server.middlewares.use("/__gpu-check", (_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Aster GPU regression check</title><body></body>");
  });
  await server.listen();
  const window = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") console.error(event.message);
  });
  const crashed = new Promise((_, reject) =>
    window.webContents.once("render-process-gone", (_event, details) =>
      reject(new Error(`GPU test renderer exited: ${details.reason}`)),
    ),
  );
  try {
    const address = server.httpServer.address();
    await window.loadURL(`http://127.0.0.1:${address.port}/__gpu-check`);
    const result = await Promise.race([
      crashed,
      window.webContents.executeJavaScript(
        "import('/scripts/gpu-nested-compositions-check.mjs').then((module) => module.run())",
      ),
    ]);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    window.destroy();
    await server.close();
  }
}

main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
