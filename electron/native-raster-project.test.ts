import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { NativeRasterProject } from "./native-raster-project";

test("authenticated raster projects hydrate only retained imports and never authorize native footage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-raster-project-"));
  try {
    const source = JSON.stringify({
      sources: [],
      compositions: [],
      fonts: [{ dataUrl: "data:font/woff2;base64,AQID" }],
      mediaImports: {
        version: 1,
        entries: [
          { kind: "imageSequence", payloadId: "sequence" },
          { kind: "still", payloadId: "image" },
          { kind: "svg", payloadId: "svg" },
          { kind: "psd", payloadId: "psd" },
        ],
        payloads: [
          {
            id: "sequence",
            kind: "imageSequence",
            frames: Array.from({ length: 4100 }, () => ({
              storage: { kind: "relative", relativePath: "not-owned.png" },
            })),
          },
          {
            id: "image",
            kind: "still",
            storage: { kind: "external", externalPath: join(tmpdir(), "not-owned.png") },
          },
          { id: "svg", kind: "svg", storage: { kind: "relative", relativePath: "owned.svg" } },
          { id: "psd", kind: "psd", storage: { kind: "inline", data: "AQID" } },
        ],
      },
    });
    const path = join(directory, "project.json");
    await writeFile(path, source);
    await writeFile(join(directory, "owned.svg"), "svg");
    const project = new NativeRasterProject(
      path,
      createHash("sha256").update(source).digest("hex"),
      "unused",
      directory,
      8 * 1024 * 1024,
    );
    const result = (await project.invoke("load_project", { path })) as {
      fonts: unknown[];
      mediaImports: { entries: { kind: string }[]; payloads: { id: string }[] };
    };
    expect(result.mediaImports.entries.map((e) => e.kind)).toEqual(["svg", "psd"]);
    expect(result.mediaImports.payloads.map((p) => p.id)).toEqual(["svg", "psd"]);
    expect(result.fonts).toEqual([{ dataUrl: "data:font/woff2;base64,AQID" }]);
    expect(new Set(project.allowedAssets.values()).size).toBe(1);
    expect(await readFile(path, "utf8")).toBe(source);
    project.dispose();
    const changed = new NativeRasterProject(
      path,
      "0".repeat(64),
      "unused",
      directory,
      8 * 1024 * 1024,
    );
    await expect(changed.invoke("load_project", { path })).rejects.toThrow();
    expect(changed.allowedAssets.size).toBe(0);
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(directory).toContain("aster-raster-project-");
    await rm(directory, { recursive: true, force: true });
  }
});
