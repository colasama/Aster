// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import type { AsterDesktopApi } from "../../desktop/api";
import { mediaImportRuntime } from "../../importers/media-import-runtime";
import { createBlankProject } from "./project";
import {
  clearCurrentProjectPath,
  loadProjectFromPath,
  readNativeRecoverySnapshotForCurrentProject,
} from "./project-file";

afterEach(() => {
  window.asterDesktop = undefined;
  clearCurrentProjectPath();
  mediaImportRuntime.clear();
});

it("keeps installed media and the save path when a prepared native load becomes stale", async () => {
  const project = createBlankProject(true);
  const invoke = vi.fn(async (command: string) =>
    command === "load_project" ? structuredClone(project) : undefined,
  );
  window.asterDesktop = { invoke, log: async () => {} } as unknown as AsterDesktopApi;
  await loadProjectFromPath("/original");
  const dispose = vi.fn();
  mediaImportRuntime.register("original-media", { kind: "audio" }, dispose);
  const loaded = vi.fn();
  await expect(
    loadProjectFromPath("/next", {
      assertCurrent: () => {
        throw new Error("stale");
      },
      loaded,
    }),
  ).rejects.toThrow("stale");
  expect(loaded).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  expect(mediaImportRuntime.has("original-media")).toBe(true);
  await readNativeRecoverySnapshotForCurrentProject();
  expect(invoke).toHaveBeenLastCalledWith("recovery_candidate", { path: "/original" });
  await loadProjectFromPath("/next", {
    assertCurrent: () => {},
    loaded: () => expect(mediaImportRuntime.has("original-media")).toBe(false),
  });
  expect(dispose).toHaveBeenCalledOnce();
  await readNativeRecoverySnapshotForCurrentProject();
  expect(invoke).toHaveBeenLastCalledWith("recovery_candidate", { path: "/next" });
});
