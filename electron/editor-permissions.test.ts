import type { BrowserWindow, Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { editorPermissionAllowed, registerEditorPermissions } from "./editor-permissions.js";

function editorWindow(contents: WebContents): BrowserWindow {
  return { webContents: contents } as BrowserWindow;
}

describe("editorPermissionAllowed", () => {
  const contents = {} as WebContents;
  const window = () => editorWindow(contents);

  it("allows local fonts and sanitized clipboard writes for the editor", () => {
    expect(editorPermissionAllowed(contents, "local-fonts", window)).toBe(true);
    expect(editorPermissionAllowed(contents, "clipboard-sanitized-write", window)).toBe(true);
  });

  it("denies clipboard reads and unlisted permissions", () => {
    expect(editorPermissionAllowed(contents, "clipboard-read", window)).toBe(false);
    expect(editorPermissionAllowed(contents, "media", window)).toBe(false);
    expect(editorPermissionAllowed(contents, "unknown", window)).toBe(false);
  });

  it("denies listed permissions for other windows", () => {
    const other = {} as WebContents;
    expect(editorPermissionAllowed(other, "clipboard-sanitized-write", window)).toBe(false);
    expect(editorPermissionAllowed(contents, "clipboard-sanitized-write", () => undefined)).toBe(
      false,
    );
  });
});

describe("registerEditorPermissions", () => {
  it("wires both handlers through the allowlist", () => {
    let check: ((contents: WebContents, permission: string) => boolean) | undefined;
    let request:
      | ((contents: WebContents, permission: string, callback: (allowed: boolean) => void) => void)
      | undefined;
    const target = {
      setPermissionCheckHandler: (handler: typeof check) => {
        check = handler;
      },
      setPermissionRequestHandler: (handler: typeof request) => {
        request = handler;
      },
    } as Session;
    const contents = {} as WebContents;
    registerEditorPermissions(target, () => editorWindow(contents));

    expect(check?.(contents, "clipboard-sanitized-write")).toBe(true);
    expect(check?.(contents, "midi")).toBe(false);
    const callback = vi.fn();
    request?.(contents, "clipboard-sanitized-write", callback);
    expect(callback).toHaveBeenCalledWith(true);
  });
});
