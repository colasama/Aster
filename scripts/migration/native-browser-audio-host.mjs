import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { writeAtomicJson } from "./report.mjs";

let window;
const timer = setTimeout(() => {
  console.error("Browser audio capture exceeded 180 seconds");
  app.exit(1);
}, 180000);
async function main() {
  const config = JSON.parse(await readFile(process.env.ASTER_BROWSER_AUDIO_CONFIG));
  app.setPath("userData", join(config.output, "profile"));
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  await window.loadURL("data:text/html,<html><body></body></html>");
  await window.webContents.executeJavaScript(
    await readFile(join(config.output, "entry.js"), "utf8"),
  );
  const oracle = await window.webContents.executeJavaScript(
    `window.captureProjectAudio(${JSON.stringify(config.projectRoot)})`,
  );
  oracle.browser = { electron: process.versions.electron, chromium: process.versions.chrome };
  await writeAtomicJson(join(config.output, "oracle.json"), oracle);
  clearTimeout(timer);
  window.destroy();
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  clearTimeout(timer);
  window?.destroy();
  app.exit(1);
});
