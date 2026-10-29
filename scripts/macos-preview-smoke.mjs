import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { NativePreviewBroker } from "../dist-electron/electron/native-preview-broker.js";
import { NativePreviewClient } from "../dist-electron/electron/native-preview-client.js";

assert.equal(process.platform, "darwin");
const profile = resolve(".aster-cache/macos-preview-smoke");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    const client = new NativePreviewClient({
      executable: resolve(process.argv[2] ?? "target/release/aster-render-cli"),
      args: [
        "preview-plan",
        "--plan",
        "tests/parity/native-temporal-frame/0/replay.fpln",
        "--resources",
        "tests/parity/native-temporal-frame/resources",
        "--resource-manifest",
        "tests/parity/native-temporal-frame/0/resources.json",
      ],
    });
    const broker = new NativePreviewBroker(client);
    const receipts = [];
    ipcMain.on("smoke-frame", (event, receipt) => {
      assert.equal(event.sender, window.webContents);
      receipts.push(receipt);
    });
    const timeout = setTimeout(() => app.exit(1), 120000);
    try {
      await window.loadURL("data:text/html,<canvas id='output'></canvas>");
      await window.webContents.executeJavaScript(`
    require('electron').sharedTexture.setSharedTextureReceiver(async ({importedSharedTexture}, identity) => {
      const frame = importedSharedTexture.getVideoFrame();
      const canvas = document.getElementById('output');
      canvas.width = frame.codedWidth; canvas.height = frame.codedHeight;
      const context = canvas.getContext('2d');
      context.drawImage(frame, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const sha256 = require('node:crypto').createHash('sha256').update(pixels).digest('hex');
      const colored = pixels.some((value, index) => index % 4 !== 3 && value > 0);
      frame.close(); importedSharedTexture.release();
      require('electron').ipcRenderer.send('smoke-frame', {sequence: identity.sequence,
        width: canvas.width, height: canvas.height, sha256, colored});
    });
  `);
      const ready = await client.ready;
      assert.equal(ready.adapter.backend, "Metal");
      for (let index = 0; index < 3; index++)
        await broker.present(window.webContents.mainFrame, {});
      assert.equal(receipts.length, 3);
      assert(
        receipts.every(
          (row, index) =>
            row.sequence === index + 1 && row.width === 320 && row.height === 180 && row.colored,
        ),
      );
      assert(receipts.every((row) => row.sha256 === receipts[0].sha256));
      await broker.close();
      console.log(JSON.stringify({ status: "passed", adapter: ready.adapter, receipts }));
      window.destroy();
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(error);
      client.abort(String(error));
      window.destroy();
      clearTimeout(timeout);
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
