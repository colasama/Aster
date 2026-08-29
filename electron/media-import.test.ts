import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverDesktopImageSequence } from "./media-import";

describe("desktop image sequence discovery", () => {
  it("discovers the selected numbered sibling pattern without unrelated images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-sequence-"));
    await Promise.all([
      writeFile(join(directory, "shot.0001.png"), "a"),
      writeFile(join(directory, "shot.0003.png"), "ccc"),
      writeFile(join(directory, "other.0002.png"), "bb"),
    ]);
    const frames = await discoverDesktopImageSequence(join(directory, "shot.0001.png"));
    expect(frames.map((frame) => frame.name)).toEqual(["shot.0001.png", "shot.0003.png"]);
    expect(frames.map((frame) => frame.size)).toEqual([1, 3]);
  });

  it("rejects non-image selections before reading siblings", async () => {
    await expect(discoverDesktopImageSequence("notes.0001.txt")).rejects.toThrow(
      "supported image frame",
    );
  });
});
