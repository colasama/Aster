import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppPreferencesStore } from "./app-preferences";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AppPreferencesStore", () => {
  it("persists validated preferences atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-preferences-"));
    roots.push(root);
    const store = new AppPreferencesStore(root);
    await store.initialize();
    await store.updateUserPreferences({
      autosaveSeconds: 15,
      locale: "zh-CN",
      viewportNavigationMode: "legacy",
    });
    await store.saveWindowState({
      x: 120,
      y: 80,
      width: 1440,
      height: 900,
      maximized: true,
    });

    const restored = new AppPreferencesStore(root);
    await restored.initialize();
    expect(restored.snapshot()).toMatchObject({
      autosaveSeconds: 15,
      locale: "zh-CN",
      viewportNavigationMode: "legacy",
      windowState: { x: 120, y: 80, width: 1440, height: 900, maximized: true },
    });
    expect(JSON.parse(await readFile(join(root, "preferences.json"), "utf8"))).toMatchObject({
      schemaVersion: 4,
      uiScale: "auto",
    });
  });

  it("imports renderer-local legacy preferences only for a new profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-preferences-"));
    roots.push(root);
    const store = new AppPreferencesStore(root);
    await store.initialize();
    await store.migrateLegacyRendererPreferences({ autosaveSeconds: 15, reducedMotion: true });
    await store.migrateLegacyRendererPreferences({ autosaveSeconds: 60 });
    expect(store.snapshot()).toMatchObject({ autosaveSeconds: 15, reducedMotion: true });
  });

  it("recovers a valid backup when the primary document is corrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-preferences-"));
    roots.push(root);
    await writeFile(join(root, "preferences.json"), "{", "utf8");
    await writeFile(
      join(root, "preferences.json.backup"),
      JSON.stringify({ schemaVersion: 1, autosaveSeconds: 60 }),
      "utf8",
    );
    const store = new AppPreferencesStore(root);
    expect(await store.initialize()).toEqual({
      recoveredBackup: true,
      resetInvalid: false,
      incompatibleFuture: false,
    });
    expect(store.snapshot().autosaveSeconds).toBe(60);
  });

  it("retains the previous successful write as a recovery point", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-preferences-"));
    roots.push(root);
    const path = join(root, "preferences.json");
    const store = new AppPreferencesStore(root);
    await store.initialize();
    await store.updateUserPreferences({ autosaveSeconds: 15 });
    await store.updateUserPreferences({ autosaveSeconds: 60 });
    await writeFile(path, "{", "utf8");

    const restored = new AppPreferencesStore(root);
    expect(await restored.initialize()).toMatchObject({ recoveredBackup: true });
    expect(restored.snapshot().autosaveSeconds).toBe(15);
  });

  it("preserves a preferences document created by a newer application", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-preferences-"));
    roots.push(root);
    const path = join(root, "preferences.json");
    const source = JSON.stringify({ schemaVersion: 99, futureSetting: "preserve-me" });
    await writeFile(path, source, "utf8");
    const store = new AppPreferencesStore(root);
    expect(await store.initialize()).toMatchObject({ incompatibleFuture: true });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("preserves a future-version backup when the primary document is damaged", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-preferences-"));
    roots.push(root);
    const primaryPath = join(root, "preferences.json");
    const backupPath = join(root, "preferences.json.backup");
    const backup = JSON.stringify({ schemaVersion: 99, futureSetting: "preserve-me" });
    await writeFile(primaryPath, "{", "utf8");
    await writeFile(backupPath, backup, "utf8");
    const store = new AppPreferencesStore(root);
    expect(await store.initialize()).toMatchObject({ incompatibleFuture: true });
    await store.updateUserPreferences({ autosaveSeconds: 15 });
    expect(await readFile(primaryPath, "utf8")).toBe("{");
    expect(await readFile(backupPath, "utf8")).toBe(backup);
  });
});
