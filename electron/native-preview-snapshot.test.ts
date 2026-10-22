import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import type { NativePreviewSnapshot } from "../src/core/rendering/native-preview-protocol";
import { preparePreviewSnapshot } from "./native-preview-snapshot";

test("snapshot media reuse retains old documents and invalidates when source identity changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-preview-snapshot-"));
  try {
    let saves = 0;
    const project = {
      sources: [{ id: "source", contentIdentity: "first", relativePath: "old.wav" }],
      compositions: [{ id: "scene", width: 320 }],
    };
    const snapshot: NativePreviewSnapshot = {
      snapshotScope: "preview:test",
      projectRevision: 0,
      compositionId: "scene",
      projectDocument: JSON.stringify(project),
      width: 320,
      height: 180,
      time: 0,
      antiAliasing: "off",
      visualization: "beauty",
      memoryBudgetMb: 512,
    };
    const options = {
      directory,
      runtime: { executable: "electron", host: "host", bundle: "bundle", bridge: "bridge" },
      save: async (path: string, document: unknown) => {
        saves++;
        const value = document as typeof project;
        value.sources[0].relativePath = `assets/${value.sources[0].contentIdentity}.wav`;
        await writeFile(join(path, "project.json"), JSON.stringify(value));
      },
    };
    const first = await preparePreviewSnapshot({ ...options, snapshot, index: 1 });
    project.compositions[0].width = 640;
    snapshot.projectDocument = JSON.stringify(project);
    const second = await preparePreviewSnapshot({
      ...options,
      snapshot,
      index: 2,
      mediaCache: first.mediaCache,
    });
    expect(saves).toBe(1);
    expect(JSON.parse(await readFile(first.project, "utf8")).compositions[0].width).toBe(320);
    const edited = JSON.parse(await readFile(second.project, "utf8"));
    expect(edited.compositions[0].width).toBe(640);
    expect(edited.sources[0].relativePath).toBe("assets/first.wav");
    project.sources[0].contentIdentity = "second";
    snapshot.projectDocument = JSON.stringify(project);
    snapshot.antiAliasing = "ssaa2x";
    const third = await preparePreviewSnapshot({
      ...options,
      snapshot,
      index: 3,
      mediaCache: second.mediaCache,
    });
    expect(saves).toBe(2);
    const request = JSON.parse(await readFile(third.request, "utf8"));
    expect(request.settings.resources.surface.renderScale).toBe(2);
    expect(request.frame.renderTarget).toEqual({ width: 640, height: 360 });
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(directory).toContain("aster-preview-snapshot-");
    await rm(directory, { recursive: true, force: true });
  }
});
