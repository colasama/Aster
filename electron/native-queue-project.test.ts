import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { sourceContentIdentity } from "../src/core/media/source-content-identity";
import type { RenderJobManifest } from "../src/core/rendering/render-queue";
import { mediaBytesIdentity } from "../src/importers/media-import-identity";
import { selectNativeQueueDocument } from "./native-queue-media";
import { prepareNativeQueueProject } from "./native-queue-project";
import { readRetainedQueueMedia } from "./native-raster-retained-media";

const runtime = {
  renderer: "renderer",
  executable: "electron",
  host: "host",
  bundle: "bundle",
  bridge: "bridge",
};

test("historical shape-only snapshots retain native upgrade admission without a source catalog", () => {
  const document = {
    schemaVersion: 3,
    compositions: [{ id: "main", layers: [{ kind: "shape" }] }],
  };
  expect(selectNativeQueueDocument(document, "main").sources).toEqual([]);
  expect(() =>
    selectNativeQueueDocument({ ...document, schemaVersion: 10, sources: undefined }, "main"),
  ).toThrow("source or composition catalog");
});
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const manifestFor = (document: unknown, media?: unknown): RenderJobManifest => {
  const prepared = structuredClone(document) as { compositions: Record<string, unknown>[] };
  prepared.compositions = prepared.compositions.map((composition) => ({
    width: 320,
    height: 180,
    duration: 1,
    frameRate: { numerator: 30, denominator: 1 },
    ...composition,
  }));
  return {
    id: "job",
    compositionId: "main",
    compositionName: "Main",
    projectRevision: 1,
    projectSnapshot: JSON.stringify(prepared),
    ...(media ? { renderMediaSnapshot: JSON.stringify(media) } : {}),
    width: 320,
    height: 180,
    frameRate: { numerator: 30, denominator: 1 },
    startFrame: 0,
    endFrameExclusive: 1,
    outputs: [],
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    antiAliasing: "ssaa2x",
  };
};
async function withDirectory(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aster-queue-project-"));
  try {
    await action(root);
  } finally {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(root).toContain("aster-queue-project-");
    await rm(root, { recursive: true, force: true });
  }
}

test("queue project freezes inline media, nested dependencies and trusted plugin states", async () =>
  withDirectory(async (root) => {
    const bytes = Buffer.from([1, 2, 3]);
    const source = {
      id: "image",
      kind: "still",
      name: "image.png",
      mimeType: "image/png",
      contentIdentity: mediaBytesIdentity(bytes),
      dataUrl: "data:image/png;base64,AQID",
    };
    const plugin = { pluginId: "com.example.cloud", nodeType: "cloud" };
    const document = {
      folders: [{ id: "folder", name: "Media" }],
      itemFolderIds: { main: "folder", nested: "folder", image: "folder", unused: "folder" },
      fonts: [{ id: "font", dataUrl: "data:font/woff2;base64,AQID" }],
      sources: [source, { ...source, id: "unused" }],
      compositions: [
        {
          id: "main",
          layers: [
            { kind: "precomposition", sourceCompositionId: "nested" },
            { kind: "generator", generator: plugin },
          ],
        },
        { id: "nested", layers: [{ kind: "image", sourceId: "image" }] },
        { id: "unused", layers: [] },
      ],
    };
    const manifest = manifestFor(document);
    const originalSnapshot = manifest.projectSnapshot;
    const options = {
      directory: join(root, "job"),
      manifest,
      authorizedPaths: [],
      runtime,
      resolvePlugins: async () => ({
        packages: [],
        unavailable: [{ ...plugin, reason: "disabled" }],
      }),
    };
    const result = await prepareNativeQueueProject(options);
    expect(manifest.projectSnapshot).toBe(originalSnapshot);
    const prepared = JSON.parse(await readFile(result.project, "utf8"));
    expect(prepared.compositions.map((c: { id: string }) => c.id)).toEqual(["main", "nested"]);
    expect(prepared.sources).toHaveLength(1);
    expect(prepared.itemFolderIds).toEqual({ main: "folder", nested: "folder", image: "folder" });
    expect(prepared.fonts).toEqual(document.fonts);
    expect(result.runtimeArguments).toContain("268435456");
    expect(prepared.sources[0].dataUrl).toBeUndefined();
    const storage = prepared.mediaImports.payloads[0].storage;
    expect(await readFile(join(result.directory, storage.relativePath))).toEqual(bytes);
    const request = JSON.parse(await readFile(result.request, "utf8"));
    expect(request.settings.resources.surface.renderScale).toBe(2);
    expect(request.unavailableGenerators).toEqual([{ ...plugin, reason: "disabled" }]);
    expect(result.projectSha256).toBe(digest(await readFile(result.project, "utf8")));
    await expect(prepareNativeQueueProject(options)).rejects.toThrow();
    expect(await readFile(result.project, "utf8")).toBe(JSON.stringify(prepared));
  }));

test("queue preparation cleans failed jobs and rejects missing or unleased media", async () =>
  withDirectory(async (root) => {
    const source = {
      id: "image",
      kind: "still",
      name: "image.png",
      mimeType: "image/png",
      contentIdentity: "legacy",
    };
    const manifest = manifestFor(
      {
        sources: [source],
        compositions: [{ id: "main", layers: [{ kind: "image", sourceId: source.id }] }],
      },
      {
        version: 1,
        entries: [
          {
            sourceId: source.id,
            sourceKind: "still",
            contentIdentity: "legacy",
            kind: "locator",
            locator: {
              kind: "session",
              url: `aster-asset://local/${encodeURIComponent(join(root, "image.png"))}`,
            },
          },
        ],
        payloads: [],
      },
    );
    await writeFile(join(root, "image.png"), "preserve");
    const directory = join(root, "failed");
    await expect(
      prepareNativeQueueProject({ directory, manifest, authorizedPaths: [], runtime }),
    ).rejects.toThrow();
    await expect(stat(directory)).rejects.toThrow();
    expect(await readFile(join(root, "image.png"), "utf8")).toBe("preserve");
    manifest.projectSnapshot = JSON.stringify({
      sources: [],
      compositions: [
        { id: "main", layers: [{ kind: "precomposition", sourceCompositionId: "missing" }] },
      ],
    });
    await expect(
      prepareNativeQueueProject({ directory, manifest, authorizedPaths: [], runtime }),
    ).rejects.toThrow("dependency is missing");
  }));

test("PSD fallback is authenticated and cannot grant an external locator", async () =>
  withDirectory(async (root) => {
    const pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const source = {
      id: "psd",
      kind: "psd",
      name: "plate.psd",
      mimeType: "image/vnd.adobe.photoshop",
      contentIdentity: "document:merged:merged",
    };
    const media = {
      version: 1,
      entries: [
        {
          sourceId: source.id,
          sourceKind: "psd",
          contentIdentity: source.contentIdentity,
          kind: "psd",
          documentIdentity: "document",
          importMode: "merged",
          layerKey: "merged",
          payloadId: "pixels",
          fallback: true,
          decodedWidth: 2,
          decodedHeight: 1,
          crop: [0, 0, 2, 1],
        },
      ],
      payloads: [
        {
          id: "pixels",
          kind: "rgba",
          identity: mediaBytesIdentity(pixels),
          bytes: pixels.toString("base64"),
        },
      ],
    };
    const manifest = manifestFor(
      {
        sources: [source],
        compositions: [{ id: "main", layers: [{ kind: "image", sourceId: source.id }] }],
      },
      media,
    );
    const prepared = await prepareNativeQueueProject({
      directory: join(root, "job"),
      manifest,
      authorizedPaths: [],
      runtime,
    });
    const request = JSON.parse(await readFile(prepared.request, "utf8"));
    const input = request.rasterProvider.retainedMedia;
    expect(JSON.parse(await readRetainedQueueMedia(prepared.project, input))).toEqual(media);
    await expect(
      readRetainedQueueMedia(prepared.project, { ...input, sha256: "0".repeat(64) }),
    ).rejects.toThrow("identity changed");
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify(media));
    await expect(
      readRetainedQueueMedia(prepared.project, { ...input, path: outside }),
    ).rejects.toThrow("inside its project");
    const changed = JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "locator",
          sourceId: "x",
          sourceKind: "still",
          contentIdentity: "x",
          locator: { kind: "inline", dataUrl: "data:image/png;base64,AQID" },
        },
      ],
      payloads: [],
    });
    await writeFile(input.path, changed);
    await expect(
      readRetainedQueueMedia(prepared.project, { ...input, sha256: digest(changed) }),
    ).rejects.toThrow("only PSD fallback");
  }));

test("legacy locator identities preserve distinct source metadata while sharing frozen bytes", async () =>
  withDirectory(async (root) => {
    const sources = [2, 3].map((width) => {
      const source = {
        id: `image-${width}`,
        kind: "still",
        name: "legacy.png",
        mimeType: "image/png",
        width,
        height: 1,
        dataUrl: "data:image/png;base64,AQID",
        contentIdentity: "",
      };
      source.contentIdentity = sourceContentIdentity(source);
      return source;
    });
    const manifest = manifestFor({
      sources,
      compositions: [
        { id: "main", layers: sources.map((source) => ({ kind: "image", sourceId: source.id })) },
      ],
    });
    const result = await prepareNativeQueueProject({
      directory: join(root, "legacy"),
      manifest,
      authorizedPaths: [],
      runtime,
    });
    const prepared = JSON.parse(await readFile(result.project, "utf8"));
    expect(
      prepared.sources.map((source: { contentIdentity: string }) => source.contentIdentity),
    ).toEqual(sources.map((source) => source.contentIdentity));
    const payloads = prepared.mediaImports.payloads;
    expect(payloads[0].storage).toEqual(payloads[1].storage);
    expect(
      payloads.every(
        (payload: { legacyLocator: { kind: string; prefix: string } }) =>
          payload.legacyLocator.kind === "inline" &&
          payload.legacyLocator.prefix === "data:image/png;base64,",
      ),
    ).toBe(true);
  }));

test("queue preparation rejects changed composition dimensions, rational clock and frame range", async () =>
  withDirectory(async (root) => {
    const original = manifestFor({ sources: [], compositions: [{ id: "main", layers: [] }] });
    for (const [index, change] of [
      { width: 640 },
      { frameRate: { numerator: 24, denominator: 1 } },
      { endFrameExclusive: 31 },
    ].entries()) {
      const directory = join(root, `invalid-${index}`);
      await expect(
        prepareNativeQueueProject({
          directory,
          manifest: { ...original, ...change },
          authorizedPaths: [],
          runtime,
        }),
      ).rejects.toThrow("immutable composition");
      await expect(stat(directory)).rejects.toThrow();
    }
  }));
