// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsterDesktopApi } from "../desktop/api";
import { createBlankProject } from "./project";
import {
  clearCurrentProjectPath,
  saveProjectDocument,
  storeRecoverySnapshot,
} from "./project-file";

afterEach(() => {
  clearCurrentProjectPath();
  window.asterDesktop = undefined;
  window.localStorage.clear();
});

describe("native project persistence", () => {
  it("queues a newer autosave behind an in-flight primary save", async () => {
    let releasePrimarySave: (() => void) | undefined;
    const primarySave = new Promise<void>((resolve) => {
      releasePrimarySave = resolve;
    });
    const commands: string[] = [];
    window.asterDesktop = {
      open: vi.fn().mockResolvedValue("C:\\Aster Project"),
      forgetActiveProject: vi.fn().mockResolvedValue(undefined),
      invoke: vi.fn().mockImplementation((command: string) => {
        commands.push(command);
        return command === "save_project" ? primarySave : Promise.resolve(undefined);
      }),
    } as unknown as AsterDesktopApi;

    const savedProject = createBlankProject();
    const saveRequest = saveProjectDocument(savedProject);
    await vi.waitFor(() => expect(commands).toEqual(["save_project"]));

    const newerProject = structuredClone(savedProject);
    newerProject.name = "Edit made while saving";
    const autosaveRequest = storeRecoverySnapshot(newerProject);
    expect(commands).toEqual(["save_project"]);

    releasePrimarySave?.();
    await Promise.all([saveRequest, autosaveRequest]);
    expect(commands).toEqual(["save_project", "clear_autosave", "save_autosave"]);
  });
});
