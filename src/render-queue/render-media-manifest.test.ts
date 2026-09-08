// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import { projectDocumentForPersistence } from "../core/project/project-file";
import type { FootageSource, Layer, Project } from "../core/types";
import { mediaImportRuntime } from "../importers/media-import-runtime";
import { parseSvgSource } from "../importers/svg";
import {
  captureRenderMediaManifest,
  createRenderMediaSnapshot,
  hydrateRenderMediaSnapshot,
  parseRenderMediaManifest,
  serializeRenderMediaManifest,
} from "./render-media-manifest";

afterEach(() => {
  mediaImportRuntime.clear();
  vi.unstubAllGlobals();
});

describe("RenderMediaManifest", () => {
  it("hydrates linked still, video and audio locators into a persistence-safe project clone", async () => {
    const project = mediaProject([
      source("still", "still", "aster-asset://local/C%3A%5Cplate.png"),
      source("video", "video", "aster-asset://local/C%3A%5Ctake.mp4"),
      source("audio", "audio", "aster-asset://local/C%3A%5Ctone.wav"),
    ]);
    const snapshot = await createRenderMediaSnapshot(project, project.activeCompositionId);
    const isolated = projectDocumentForPersistence(project);

    expect(isolated.sources.every((candidate) => !candidate.runtimeUrl)).toBe(true);
    const lease = await hydrateRenderMediaSnapshot(isolated, snapshot);
    expect(isolated.sources.map((candidate) => candidate.runtimeUrl)).toEqual(
      project.sources.map((candidate) => candidate.runtimeUrl),
    );

    lease.dispose();
    expect(isolated.sources.every((candidate) => !candidate.runtimeUrl)).toBe(true);
  });

  it("hydrates SVG, decoded PSD fallback and image sequence state in an isolated registry", async () => {
    const svg = source("svg", "svg", "aster-runtime://svg");
    const psd = source("psd", "psd", "aster-runtime://psd");
    const sequence = source("imageSequence", "sequence", "aster-runtime://sequence");
    const project = mediaProject([svg, psd, sequence]);
    registerSvg(svg.id, "#f00");
    mediaImportRuntime.register(psd.id, {
      kind: "psd",
      documentIdentity: "psd:document",
      importMode: "composition",
      layerKey: "layer:hero",
      decodedWidth: 2,
      decodedHeight: 1,
      crop: [0, 0, 2, 1],
      pixels: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    registerSequence(sequence.id, "data:image/png;base64,AQID");
    const snapshot = await createRenderMediaSnapshot(project, project.activeCompositionId);
    const isolated = projectDocumentForPersistence(project);
    mediaImportRuntime.clear();

    const lease = await hydrateRenderMediaSnapshot(isolated, snapshot);

    expect(mediaImportRuntime.get(svg.id)).toMatchObject({ kind: "svg" });
    expect(mediaImportRuntime.get(psd.id)).toMatchObject({
      kind: "psd",
      layerKey: "layer:hero",
    });
    expect(mediaImportRuntime.get(sequence.id)).toMatchObject({ kind: "imageSequence" });
    const hydratedSequence = mediaImportRuntime.get(sequence.id);
    if (hydratedSequence?.kind !== "imageSequence")
      throw new Error("Hydrated image sequence is unavailable");
    expect(hydratedSequence.selection.frames[0]?.file.url).toBe("data:image/png;base64,AQID");

    lease.dispose();
    expect(mediaImportRuntime.get(svg.id)).toBeUndefined();
    expect(mediaImportRuntime.get(psd.id)).toBeUndefined();
    expect(mediaImportRuntime.get(sequence.id)).toBeUndefined();
  });

  it("deduplicates one compressed PSD document across layer recipes", async () => {
    const first = source("psd", "psd-a", "aster-runtime://psd-a");
    const second = source("psd", "psd-b", "aster-runtime://psd-b");
    const project = mediaProject([first, second]);
    const documentBytes = new Uint8Array([8, 7, 6, 5]);
    registerPsdDocument(first.id, "layer:a", documentBytes);
    registerPsdDocument(second.id, "layer:b", documentBytes);

    const manifest = parseRenderMediaManifest(
      await createRenderMediaSnapshot(project, project.activeCompositionId),
    );

    expect(manifest.payloads).toHaveLength(1);
    expect(manifest.payloads[0]?.kind).toBe("psdDocument");
    expect(
      manifest.entries.filter((entry) => entry.kind === "psd").map((entry) => entry.payloadId),
    ).toEqual(["psd:psd:document", "psd:psd:document"]);
  });

  it("fixes runtime identity and pixels before asynchronous serialization yields", async () => {
    const psd = source("psd", "psd", "aster-runtime://psd");
    const project = mediaProject([psd]);
    const pixels = new Uint8ClampedArray([1, 2, 3, 4]);
    mediaImportRuntime.register(psd.id, {
      kind: "psd",
      documentIdentity: "psd:mutation",
      importMode: "merged",
      layerKey: "merged",
      decodedWidth: 1,
      decodedHeight: 1,
      crop: [0, 0, 1, 1],
      pixels,
    });
    const capture = captureRenderMediaManifest(project, project.activeCompositionId);
    project.sources[0].contentIdentity = "changed";
    pixels.fill(255);

    const manifest = parseRenderMediaManifest(await serializeRenderMediaManifest(capture));
    expect(manifest.entries[0]?.contentIdentity).toBe("identity:psd");
    expect(manifest.payloads[0]?.bytes).toBe("AQIDBA==");
  });

  it("rejects missing runtime state and source identity mismatches before frame one", async () => {
    const svg = source("svg", "svg", "aster-runtime://svg");
    const project = mediaProject([svg]);
    expect(() => captureRenderMediaManifest(project, project.activeCompositionId)).toThrow(
      "runtime",
    );

    registerSvg(svg.id, "#fff");
    const snapshot = await createRenderMediaSnapshot(project, project.activeCompositionId);
    const isolated = projectDocumentForPersistence(project);
    isolated.sources[0].contentIdentity = "different";
    await expect(hydrateRenderMediaSnapshot(isolated, snapshot)).rejects.toThrow(
      "identity mismatch",
    );
    expect(mediaImportRuntime.get(svg.id)).toMatchObject({ kind: "svg" });
  });

  it("rejects corrupted payload bytes and revalidates SVG markup during host hydration", async () => {
    const psd = source("psd", "psd", "aster-runtime://psd");
    const project = mediaProject([psd]);
    mediaImportRuntime.register(psd.id, {
      kind: "psd",
      documentIdentity: "psd:corrupt",
      importMode: "merged",
      layerKey: "merged",
      decodedWidth: 1,
      decodedHeight: 1,
      crop: [0, 0, 1, 1],
      pixels: new Uint8ClampedArray([1, 2, 3, 4]),
    });
    const corrupt = JSON.parse(
      await createRenderMediaSnapshot(project, project.activeCompositionId),
    );
    corrupt.payloads[0].bytes = "/////w==";
    const isolated = projectDocumentForPersistence(project);
    mediaImportRuntime.clear();
    await expect(hydrateRenderMediaSnapshot(isolated, JSON.stringify(corrupt))).rejects.toThrow(
      "payload identity mismatch",
    );

    const svg = source("svg", "svg-corrupt", "aster-runtime://svg");
    const svgProject = mediaProject([svg]);
    registerSvg(svg.id, "#fff");
    const unsafe = JSON.parse(
      await createRenderMediaSnapshot(svgProject, svgProject.activeCompositionId),
    );
    unsafe.entries[0].parsed.sanitized =
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><script/></svg>';
    mediaImportRuntime.clear();
    await expect(
      hydrateRenderMediaSnapshot(projectDocumentForPersistence(svgProject), JSON.stringify(unsafe)),
    ).rejects.toThrow("not allowed");
  });

  it("inlines blob-only sequence frames instead of leaking cross-renderer object URLs", async () => {
    const sequence = source("imageSequence", "sequence", "aster-runtime://sequence");
    const project = mediaProject([sequence]);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))),
    );
    registerSequence(sequence.id, "blob:editor-only-frame");

    const manifest = parseRenderMediaManifest(
      await createRenderMediaSnapshot(project, project.activeCompositionId),
    );
    const entry = manifest.entries[0];
    if (entry?.kind !== "imageSequence") throw new Error("Sequence entry is unavailable");
    expect(entry.selection.frames[0]?.file.locator).toEqual({
      kind: "inline",
      dataUrl: "data:image/png;base64,AQID",
    });
  });

  it("keeps native sequence frames as streamed locators instead of manifest-sized inline data", async () => {
    const sequence = source("imageSequence", "sequence", "aster-runtime://sequence");
    const project = mediaProject([sequence]);
    registerSequence(
      sequence.id,
      "aster-asset://local/C%3A%5Cplates%5Cframe_0001.png",
      "fnv64:0102030405060708:3",
    );

    const manifest = parseRenderMediaManifest(
      await createRenderMediaSnapshot(project, project.activeCompositionId),
    );
    const entry = manifest.entries[0];
    if (entry?.kind !== "imageSequence") throw new Error("Sequence entry is unavailable");
    expect(entry.selection.frames[0]?.file).toMatchObject({
      byteIdentity: "fnv64:0102030405060708:3",
      locator: {
        kind: "session",
        url: "aster-asset://local/C%3A%5Cplates%5Cframe_0001.png",
      },
    });
  });
});

function mediaProject(sources: FootageSource[]): Project {
  const project = createBlankProject();
  const composition = project.compositions[0];
  if (!composition) throw new Error("Blank composition is unavailable");
  composition.layers = sources.map((candidate) => layerForSource(candidate, composition));
  project.sources = sources;
  return project;
}

function layerForSource(
  source: FootageSource,
  composition: Project["compositions"][number],
): Layer {
  const kind = source.kind === "video" ? "video" : source.kind === "audio" ? "audio" : "image";
  const layer = createLayerForComposition(kind, composition);
  layer.sourceId = source.id;
  return layer;
}

function source(kind: FootageSource["kind"], id: string, runtimeUrl: string): FootageSource {
  const common = {
    id,
    name: id,
    mimeType: kind === "audio" ? "audio/wav" : kind === "video" ? "video/mp4" : "image/png",
    contentIdentity: `identity:${id}`,
    runtimeUrl,
    interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
  };
  if (kind === "audio")
    return { ...common, kind, duration: 1, channels: 2, sampleRate: 48_000, streamIndex: 0 };
  if (kind === "video") return { ...common, kind, duration: 1, width: 2, height: 2 };
  if (kind === "imageSequence")
    return {
      ...common,
      kind,
      width: 2,
      height: 2,
      pattern: "frame_[####].png",
      startFrame: 1,
      endFrame: 1,
    };
  if (kind === "psd") return { ...common, kind, width: 2, height: 2, layerCount: 2 };
  return { ...common, kind, width: 2, height: 2 };
}

function registerSvg(sourceId: string, fill: string): void {
  mediaImportRuntime.register(sourceId, {
    kind: "svg",
    parsed: parseSvgSource(
      `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2"><path fill="${fill}"/></svg>`,
    ),
  });
}

function registerSequence(sourceId: string, url: string, byteIdentity?: string): void {
  mediaImportRuntime.register(sourceId, {
    kind: "imageSequence",
    selection: {
      pattern: "frame_[####].png",
      prefix: "frame_",
      extension: ".png",
      padding: 4,
      startFrame: 1,
      endFrame: 1,
      missingFrames: [],
      frames: [
        {
          frame: 1,
          file: {
            name: "frame_0001.png",
            size: 3,
            lastModified: 1,
            type: "image/png",
            url,
            ...(byteIdentity ? { byteIdentity } : {}),
          },
        },
      ],
    },
    frameRate: { numerator: 24, denominator: 1 },
    missingFramePolicy: "error",
    loop: false,
  });
}

function registerPsdDocument(sourceId: string, layerKey: string, bytes: Uint8Array): void {
  mediaImportRuntime.register(sourceId, {
    kind: "psd",
    documentIdentity: "psd:document",
    importMode: "composition",
    layerKey,
    documentBytes: bytes,
    decodedWidth: 1,
    decodedHeight: 1,
    crop: [0, 0, 1, 1],
    pixels: new Uint8ClampedArray([0, 0, 0, 0]),
  });
}
