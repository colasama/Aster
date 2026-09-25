import type { BrowserWindow, Session, WebContents } from "electron";

// Installing permission handlers makes Chromium route every renderer permission through them.
// Anything not listed here is denied, including clipboard writes the web platform grants by
// default with a user gesture.
const EDITOR_PERMISSIONS = new Set(["local-fonts", "clipboard-sanitized-write"]);

export function editorPermissionAllowed(
  contents: WebContents | null,
  permission: string,
  window: () => BrowserWindow | undefined,
): boolean {
  return EDITOR_PERMISSIONS.has(permission) && contents === window()?.webContents;
}

export function registerEditorPermissions(
  target: Session,
  window: () => BrowserWindow | undefined,
): void {
  target.setPermissionCheckHandler((contents, permission) =>
    editorPermissionAllowed(contents, String(permission), window),
  );
  target.setPermissionRequestHandler((contents, permission, callback) => {
    callback(editorPermissionAllowed(contents, String(permission), window));
  });
}
