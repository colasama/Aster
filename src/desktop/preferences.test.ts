import { describe, expect, it } from "vitest";
import {
  applyUserPreferencePatch,
  defaultAppPreferences,
  forgetRecentProject,
  migrateAppPreferences,
  rememberRecentProject,
} from "./preferences";

describe("application preferences", () => {
  it("migrates the legacy unversioned document and sanitizes invalid fields", () => {
    expect(
      migrateAppPreferences({
        autosaveSeconds: 15,
        reducedMotion: true,
        gpuMemoryBudgetMb: 128,
        recentProjects: ["C:\\projects\\one", "C:\\projects\\ONE", 7],
      }),
    ).toMatchObject({
      schemaVersion: 1,
      autosaveSeconds: 15,
      reducedMotion: true,
      gpuMemoryBudgetMb: 128,
      recentProjects: ["C:\\projects\\ONE"],
    });
  });

  it("rejects future versions without destroying their contents", () => {
    expect(() => migrateAppPreferences({ schemaVersion: 99 })).toThrow("newer than this build");
  });

  it("restricts renderer updates to user-facing preferences", () => {
    const current = defaultAppPreferences();
    expect(applyUserPreferencePatch(current, { autosaveSeconds: 60 }).autosaveSeconds).toBe(60);
    expect(() => applyUserPreferencePatch(current, { recentProjects: ["injected"] })).toThrow(
      "cannot be updated here",
    );
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
