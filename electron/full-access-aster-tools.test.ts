import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fullAccessDesktopBridgeRequest } from "./full-access-aster-tools";

describe("Full Access Aster service tools", () => {
  it("maps typed plugin and project tools to the existing desktop bridge", () => {
    expect(
      fullAccessDesktopBridgeRequest("set_plugin_enabled", {
        pluginId: "com.example.plugin",
        enabled: true,
      }),
    ).toEqual({
      command: "set_plugin_enabled",
      arguments: { pluginId: "com.example.plugin", enabled: true },
    });
    expect(
      fullAccessDesktopBridgeRequest("pack_project", {
        bundle: "project",
        destination: "packed.aster",
      }),
    ).toEqual({
      command: "pack_project",
      arguments: { bundle: resolve("project"), destination: resolve("packed.aster") },
    });
  });

  it("rejects invalid asset kinds and filesystem roots", () => {
    expect(() =>
      fullAccessDesktopBridgeRequest("link_project_asset", {
        bundle: "project",
        source: "sound.wav",
        kind: "audio",
      }),
    ).toThrow("image or video");
    const root = process.platform === "win32" ? "C:\\" : "/";
    expect(() => fullAccessDesktopBridgeRequest("install_plugin", { source: root })).toThrow(
      "root",
    );
  });
});
