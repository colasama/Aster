import { describe, expect, it } from "vitest";
import {
  applyUserPreferencePatch,
  defaultAppPreferences,
  forgetRecentProject,
  migrateAppPreferences,
  rememberRecentProject,
} from "./preferences";

describe("application preferences", () => {
  it("migrates preview navigation to Smooth and round-trips both navigation modes", () => {
    expect(defaultAppPreferences().viewportNavigationMode).toBe("smooth");
    for (const schemaVersion of [0, 1, 2, 3, 4])
      expect(migrateAppPreferences({ schemaVersion }).viewportNavigationMode).toBe("smooth");
    for (const viewportNavigationMode of ["smooth", "legacy"] as const) {
      const updated = applyUserPreferencePatch(defaultAppPreferences(), { viewportNavigationMode });
      expect(
        migrateAppPreferences(JSON.parse(JSON.stringify(updated))).viewportNavigationMode,
      ).toBe(viewportNavigationMode);
    }
    expect(
      applyUserPreferencePatch(defaultAppPreferences(), { viewportNavigationMode: "invalid" })
        .viewportNavigationMode,
    ).toBe("smooth");
  });
  it("defaults new and legacy profiles to FXAA while preserving explicit AA choices", () => {
    expect(defaultAppPreferences().antiAliasing).toBe("fxaa");
    expect(migrateAppPreferences({ schemaVersion: 2 }).antiAliasing).toBe("fxaa");
    expect(migrateAppPreferences({ schemaVersion: 3 }).antiAliasing).toBe("fxaa");
    for (const antiAliasing of ["off", "fxaa", "ssaa2x", "ssaa4x"] as const) {
      const updated = applyUserPreferencePatch(defaultAppPreferences(), { antiAliasing });
      expect(migrateAppPreferences(JSON.parse(JSON.stringify(updated))).antiAliasing).toBe(
        antiAliasing,
      );
    }
    expect(
      applyUserPreferencePatch(defaultAppPreferences(), { antiAliasing: "invalid" }).antiAliasing,
    ).toBe("off");
  });
  it("migrates the legacy unversioned document and sanitizes invalid fields", () => {
    expect(
      migrateAppPreferences({
        autosaveSeconds: 15,
        reducedMotion: true,
        gpuMemoryBudgetMb: 128,
        recentProjects: ["C:\\projects\\one", "C:\\projects\\ONE", 7],
      }),
    ).toMatchObject({
      schemaVersion: 4,
      autosaveSeconds: 15,
      reducedMotion: true,
      gpuMemoryBudgetMb: 128,
      uiScale: "auto",
      recentProjects: ["C:\\projects\\ONE"],
    });
  });

  it("rejects future versions without destroying their contents", () => {
    expect(() => migrateAppPreferences({ schemaVersion: 99 })).toThrow("newer than this build");
  });

  it("restricts renderer updates to user-facing preferences", () => {
    const current = defaultAppPreferences();
    expect(applyUserPreferencePatch(current, { autosaveSeconds: 60 }).autosaveSeconds).toBe(60);
    expect(applyUserPreferencePatch(current, { uiScale: 1.25 }).uiScale).toBe(1.25);
    expect(applyUserPreferencePatch(current, { uiScale: 1.2 as 1.25 }).uiScale).toBe("auto");
    expect(() => applyUserPreferencePatch(current, { recentProjects: ["injected"] })).toThrow(
      "cannot be updated here",
    );
  });

  it("migrates v1 preferences to a system-following UI scale", () => {
    expect(migrateAppPreferences({ schemaVersion: 1, autosaveSeconds: 30 })).toMatchObject({
      schemaVersion: 4,
      uiScale: "auto",
    });
  });

  it("keeps recent projects unique, ordered, and bounded", () => {
    let preferences = defaultAppPreferences();
    for (let index = 0; index < 12; index += 1)
      preferences = rememberRecentProject(preferences, `C:\\projects\\${index}`);
    preferences = rememberRecentProject(preferences, "c:\\PROJECTS\\5");
    expect(preferences.recentProjects).toHaveLength(10);
    expect(preferences.recentProjects[0]).toBe("c:\\PROJECTS\\5");
    expect(
      preferences.recentProjects.filter((path) => path.toLocaleLowerCase().endsWith("\\5")),
    ).toHaveLength(1);
    preferences = forgetRecentProject(preferences, "C:\\PROJECTS\\5");
    expect(preferences.recentProjects.some((path) => path.endsWith("\\5"))).toBe(false);
  });
});
