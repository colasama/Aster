import { type BrowserWindow, ipcMain } from "electron";

// Fixed code and a user gesture let external automation use Chromium's native font inventory.
const FONT_INVENTORY_SCRIPT = `window.queryLocalFonts().then(fonts => fonts.map(({family, fullName, postscriptName, style}) => ({family, fullName, postscriptName, style})))`;

export function registerFontAccess(window: () => BrowserWindow | undefined) {
  let pending: { ownerId: number; result: Promise<unknown> } | undefined;
  ipcMain.handle("aster:fonts-list", async (event) => {
    if (event.sender !== window()?.webContents || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Font inventory is restricted to the editor");
    if (pending?.ownerId === event.sender.id) return pending.result;
    const result = (async () => {
      // Chromium requires a visible page even with permission. Keep background MCP calls working
      // without focusing the editor, then restore its normal power-saving policy.
      const throttling = event.sender.getBackgroundThrottling();
      event.sender.setBackgroundThrottling(false);
      try {
        return await event.sender.executeJavaScript(FONT_INVENTORY_SCRIPT, true);
      } finally {
        if (!event.sender.isDestroyed()) event.sender.setBackgroundThrottling(throttling);
      }
    })();
    pending = { ownerId: event.sender.id, result };
    try {
      return await result;
    } finally {
      if (pending?.result === result) pending = undefined;
    }
  });
}
