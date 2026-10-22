import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { expect, test } from "vitest";
import { materializePreviewAssets } from "./native-preview-assets";
import { renderPathKey } from "./render-queue-paths";

test("legacy snapshots preserve authorized assets and never rewrite an earlier content copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-preview-assets-"));
  try {
    const source = join(directory, "source.wav");
    const authorized = toNamespacedPath(source);
    const url = `aster-asset://local/${encodeURIComponent(authorized)}`;
    const relativePath = "assets/imports/old.wav";
    const assets = [{ relativePath, url }];
    const allowed = new Map([[renderPathKey(authorized), authorized]]);
    await writeFile(source, "first content");
    const first = { sources: [{ relativePath }] };
    const store = join(directory, "private");
    await materializePreviewAssets(store, first, assets, allowed);
    const original = first.sources[0].relativePath;
    expect(original).toContain(createHash("sha256").update("first content").digest("hex"));
    await writeFile(source, "next content");
    const second = { sources: [{ relativePath }] };
    await materializePreviewAssets(store, second, assets, allowed);
    expect(second.sources[0].relativePath).not.toBe(original);
    expect(await readFile(join(store, original), "utf8")).toBe("first content");
    expect(await readFile(join(store, second.sources[0].relativePath), "utf8")).toBe(
      "next content",
    );
    await expect(materializePreviewAssets(store, second, assets, new Map())).rejects.toThrow(
      "not admitted",
    );
    await expect(
      materializePreviewAssets(
        store,
        second,
        [{ relativePath, url: "file:///secret.wav" }],
        allowed,
      ),
    ).rejects.toThrow("asset protocol");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(directory).toContain("aster-preview-assets-");
    await rm(directory, { recursive: true, force: true });
  }
});
