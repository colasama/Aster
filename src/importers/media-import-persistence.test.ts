// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { createBlankProject } from "../core/project";
import {
  openPersistedProjectDocument,
  projectDocumentWithMediaImports,
  readRecoverySnapshot,
  storeRecoverySnapshot,
} from "../core/project-file";
import type { FootageSource, Project } from "../core/types";
import type { AsterDesktopApi } from "../desktop/api";
import { createImageSequenceImport, createPsdImport, createSvgImport } from "./advanced-import";
import { detectImageSequence } from "./image-sequence";
import { mediaBytesIdentity } from "./media-import-identity";
import {
  createPersistedMediaImports,
  hydratePersistedMediaImports,
  MAX_PORTABLE_MEDIA_BYTES,
  validatePersistedMediaImports,
} from "./media-import-persistence";
import { mediaImportRuntime, type RuntimeSequenceFile } from "./media-import-runtime";
import { parsePsd } from "./psd";

afterEach(() => {
  mediaImportRuntime.clear();
  window.asterDesktop = undefined;
});

describe("advanced media project persistence", () => {
  it("migrates legacy embedded video into a recoverable media payload", async () => {
    const project = createBlankProject();
    const bytes = new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]);
    const source: FootageSource = {
      id: "legacy-video",
      kind: "video",
      name: "legacy.mp4",
      mimeType: "video/mp4",
      contentIdentity: await sha256Identity(bytes),
      dataUrl: `data:video/mp4;base64,${btoa(String.fromCharCode(...bytes))}`,
      interpretation: { alpha: "straight", colorSpace: "srgb" },
      width: 16,
      height: 9,
      duration: 1,
    };
    project.sources.push(source);

    const document = await projectDocumentWithMediaImports(project, "native");
    expect(document.sources[0]?.dataUrl).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain("data:video/mp4");
    expect(document.mediaImports?.entries[0]).toMatchObject({
      sourceId: source.id,
      kind: "video",
    });
    expect(document.mediaImports?.payloads[0]).toMatchObject({
      kind: "video",
      mimeType: "video/mp4",
      extension: ".mp4",
      storage: { kind: "inline" },
    });

    const reopened = await openPersistedProjectDocument(structuredClone(document));
    expect(reopened.sources[0]).toMatchObject({
      id: source.id,
      kind: "video",
      runtimeUrl: expect.stringMatching(/^blob:/),
    });
    expect(mediaImportRuntime.get(source.id)).toMatchObject({ kind: "video" });
  });

  it("captures picker-authorized native footage without embedding its bytes", async () => {
    const project = createBlankProject();
    const source: FootageSource = {
      id: "native-audio",
      kind: "audio",
      name: "dialogue.wav",
      mimeType: "audio/wav",
      contentIdentity: `sha256:${"0".repeat(64)}`,
      runtimeUrl: "aster-asset://local/dialogue.wav",
      interpretation: { alpha: "ignore", colorSpace: "srgb" },
      duration: 2,
      channels: 2,
      sampleRate: 48_000,
      streamIndex: 0,
    };
    project.sources.push(source);
    mediaImportRuntime.register(source.id, {
      kind: "audio",
      originalPath: "C:\\Media\\dialogue.wav",
    });

    const document = await projectDocumentWithMediaImports(project, "native");
    expect(document.sources[0]).not.toHaveProperty("runtimeUrl");
    expect(document.sources[0]).not.toHaveProperty("dataUrl");
    expect(document.mediaImports?.payloads[0]).toMatchObject({
      kind: "audio",
      extension: ".wav",
      storage: { kind: "external", externalPath: "C:\\Media\\dialogue.wav" },
    });
    expect(JSON.stringify(document)).not.toContain("base64");
  });

  it("hydrates a materialized audio payload as a bundle-relative runtime locator", async () => {
    const project = createBlankProject();
    const source: FootageSource = {
      id: "materialized-audio",
      kind: "audio",
      name: "dialogue.wav",
      mimeType: "audio/wav",
      contentIdentity: `sha256:${"1".repeat(64)}`,
      interpretation: { alpha: "ignore", colorSpace: "srgb" },
      duration: 2,
      channels: 2,
      sampleRate: 48_000,
      streamIndex: 0,
    };
    project.sources.push(source);
    const relativePath = "assets/imports/content.wav";
    const resolvedPath = "C:\\Project\\assets\\imports\\content.wav";
    window.asterDesktop = {
      convertFileSrc: (path: string) => `aster-asset://local/${encodeURIComponent(path)}`,
    } as unknown as AsterDesktopApi;

    await hydratePersistedMediaImports(
      project,
      {
        version: 1,
        entries: [
          {
            sourceId: source.id,
            kind: "audio",
            contentIdentity: source.contentIdentity,
            payloadId: "footage:audio",
          },
        ],
        payloads: [
          {
            id: "footage:audio",
            kind: "audio",
            contentIdentity: source.contentIdentity,
            mimeType: source.mimeType,
            extension: ".wav",
            storage: {
              kind: "relative",
              relativePath,
              byteIdentity: "fnv64:0000000000000000:3",
              resolvedPath,
            },
          },
        ],
      },
      { allowResolvedPaths: true },
    );

    expect(source).toMatchObject({
      relativePath,
      runtimeUrl: `aster-asset://local/${encodeURIComponent(resolvedPath)}`,
    });
    expect(mediaImportRuntime.get(source.id)).toEqual({
      kind: "audio",
      originalPath: resolvedPath,
    });
  });

  it("continues to open legacy embedded footage without a sidecar", async () => {
    const project = createBlankProject();
    project.sources.push({
      id: "legacy-audio",
      kind: "audio",
      name: "legacy.wav",
      mimeType: "audio/wav",
      contentIdentity: "legacy:audio",
      dataUrl: "data:audio/wav;base64,AA==",
      interpretation: { alpha: "ignore", colorSpace: "srgb" },
      duration: 1,
      channels: 1,
      sampleRate: 8_000,
      streamIndex: 0,
    });
    const reopened = await openPersistedProjectDocument(structuredClone(project));
    expect(reopened.sources[0]?.dataUrl).toBe("data:audio/wav;base64,AA==");
  });

  it("roundtrips a rerasterizable SVG without persisting a runtime URL", async () => {
    const project = createBlankProject();
    const imported = createSvgImport(
      {
        width: 64,
        height: 32,
        viewBox: [0, 0, 64, 32],
        sanitized: '<svg viewBox="0 0 64 32"><rect width="64" height="32"/></svg>',
        nodeCount: 2,
      },
      "logo.svg",
      project.compositions[0],
      0,
      "blob:session-only",
    );
    attach(project, imported.sources, imported.layers);

    const document = await projectDocumentWithMediaImports(project, "portable");
    expect(JSON.stringify(document)).not.toContain("blob:session-only");
    expect(document.mediaImports?.payloads).toHaveLength(1);
    mediaImportRuntime.clear();

    const reopened = await openPersistedProjectDocument(structuredClone(document));
    const source = reopened.sources[0];
    expect(source && mediaImportRuntime.get(source.id)).toMatchObject({
      kind: "svg",
      parsed: { width: 64, height: 32, nodeCount: 3 },
    });
  });

  it("rebuilds advanced runtime state from a browser recovery snapshot", async () => {
    const project = svgProject();
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    };
    await storeRecoverySnapshot(project, storage);
    expect([...entries.values()][0]).not.toContain("aster-runtime://");
    mediaImportRuntime.clear();

    const recovered = await readRecoverySnapshot(storage);
    const source = recovered?.sources[0];
    expect(source && mediaImportRuntime.get(source.id)).toMatchObject({
      kind: "svg",
      parsed: { width: 8, height: 8 },
    });
  });

  it("stores one compressed PSD document for every recovered layer", async () => {
    const project = createBlankProject();
    const bytes = new Uint8Array(minimalPsd());
    const document = await parsePsd(bytes.buffer.slice(0));
    const imported = createPsdImport(
      document,
      "merged",
      "design.psd",
      mediaBytesIdentity(bytes),
      project.compositions[0],
      0,
      bytes,
    );
    const source = imported.sources[0];
    if (!source) throw new Error("PSD fixture did not create a source");
    const duplicate = { ...source, id: "psd-second-layer", name: "Second reference" };
    const runtime = mediaImportRuntime.get(source.id);
    if (!runtime) throw new Error("PSD runtime is missing");
    mediaImportRuntime.register(duplicate.id, runtime);
    attach(project, [source, duplicate], imported.layers);

    const sidecar = await createPersistedMediaImports(project, "portable");
    expect(sidecar?.entries).toHaveLength(2);
    expect(sidecar?.payloads).toHaveLength(1);
    expect(JSON.stringify(sidecar).match(/"data"/g)).toHaveLength(1);
    mediaImportRuntime.clear();

    await hydratePersistedMediaImports(project, structuredClone(sidecar));
    const firstRuntime = mediaImportRuntime.get(source.id);
    const secondRuntime = mediaImportRuntime.get(duplicate.id);
    expect(firstRuntime).toMatchObject({
      kind: "psd",
      documentIdentity: mediaBytesIdentity(bytes),
    });
    expect(secondRuntime).toMatchObject({
      kind: "psd",
      documentIdentity: mediaBytesIdentity(bytes),
    });
    expect(firstRuntime?.kind === "psd" && secondRuntime?.kind === "psd").toBe(true);
    if (firstRuntime?.kind === "psd" && secondRuntime?.kind === "psd")
      expect(firstRuntime.documentBytes).toBe(secondRuntime.documentBytes);
  });

  it("roundtrips a bounded image sequence and reports a missing bundle frame precisely", async () => {
    const project = createBlankProject();
    const files = [
      sequenceFile("plate.0001.png", [1, 2, 3]),
      sequenceFile("plate.0003.png", [4, 5]),
    ];
    const imported = createImageSequenceImport(
      { selection: detectImageSequence(files, files[0]?.name) },
      [1920, 1080],
      {
        frameRate: { numerator: 24_000, denominator: 1_001 },
        missingFramePolicy: "holdPrevious",
      },
      project.compositions[0],
      0,
    );
    attach(project, imported.sources, imported.layers);
    const sidecar = await createPersistedMediaImports(project, "portable");
    mediaImportRuntime.clear();

    await hydratePersistedMediaImports(project, structuredClone(sidecar));
    const source = imported.sources[0];
    const runtime = source && mediaImportRuntime.get(source.id);
    expect(runtime).toMatchObject({
      kind: "imageSequence",
      missingFramePolicy: "holdPrevious",
      selection: { missingFrames: [2] },
    });

    const missing = structuredClone(sidecar) as unknown as {
      payloads: Array<{
        kind: string;
        frames: Array<{
          frame: number;
          name: string;
          size: number;
          lastModified: number;
          type: string;
          storage: Record<string, unknown> & { byteIdentity?: string };
        }>;
      }>;
    };
    const payload = missing.payloads[0];
    if (payload?.kind !== "imageSequence") throw new Error("Sequence payload is missing");
    payload.frames[0] = {
      ...payload.frames[0],
      storage: {
        kind: "relative",
        relativePath: "assets/imports/missing.png",
        byteIdentity: payload.frames[0]?.storage.byteIdentity ?? "",
      },
    };
    await expect(hydratePersistedMediaImports(project, missing)).rejects.toThrow(
      "mediaImports.entries[0].frames[0] image sequence frame is missing",
    );
  });

  it("rejects identity mismatch, runtime locators, and oversize payloads atomically", async () => {
    const project = svgProject();
    const sidecar = await createPersistedMediaImports(project, "portable");
    mediaImportRuntime.clear();
    mediaImportRuntime.register("sentinel", {
      kind: "svg",
      parsed: {
        width: 1,
        height: 1,
        viewBox: [0, 0, 1, 1],
        sanitized: '<svg viewBox="0 0 1 1"/>',
        nodeCount: 1,
      },
    });
    const mismatch = structuredClone(sidecar) as unknown as {
      entries: Array<Record<string, unknown>>;
    };
    mismatch.entries[0] = { ...mismatch.entries[0], contentIdentity: "fnv64:0000000000000000:1" };
    await expect(hydratePersistedMediaImports(project, mismatch)).rejects.toThrow(
      "identity mismatch",
    );
    expect(mediaImportRuntime.has("sentinel")).toBe(true);

    const unsafe = structuredClone(sidecar) as unknown as {
      payloads: Array<{ storage: Record<string, unknown> }>;
    };
    if (!unsafe.payloads[0]) throw new Error("SVG payload is missing");
    unsafe.payloads[0].storage.runtimeUrl = "blob:forbidden";
    expect(() => validatePersistedMediaImports(unsafe)).toThrow("runtimeUrl must not be persisted");

    const oversize = structuredClone(sidecar) as unknown as {
      payloads: Array<{ storage: { byteIdentity: string } }>;
    };
    if (!oversize.payloads[0]) throw new Error("SVG payload is missing");
    oversize.payloads[0].storage.byteIdentity = `fnv64:0000000000000000:${MAX_PORTABLE_MEDIA_BYTES + 1}`;
    expect(() => validatePersistedMediaImports(oversize)).toThrow("portable media payload limit");
  });
});

function svgProject(): Project {
  const project = createBlankProject();
  const imported = createSvgImport(
    {
      width: 8,
      height: 8,
      viewBox: [0, 0, 8, 8],
      sanitized: '<svg viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>',
      nodeCount: 2,
    },
    "fixture.svg",
    project.compositions[0],
    0,
  );
  attach(project, imported.sources, imported.layers);
  return project;
}

function attach(
  project: Project,
  sources: readonly FootageSource[],
  layers: Project["compositions"][number]["layers"],
): void {
  project.sources.push(...sources);
  project.compositions[0].layers.push(...layers);
}

function sequenceFile(name: string, values: readonly number[]): RuntimeSequenceFile {
  const bytes = new Uint8Array(values);
  return {
    name,
    size: bytes.byteLength,
    lastModified: 1,
    type: "image/png",
    url: `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`,
  };
}

function minimalPsd(): ArrayBuffer {
  const writer = new BinaryWriter();
  writer.ascii("8BPS").u16(1).zero(6).u16(3).u32(1).u32(2).u16(8).u16(3);
  writer.u32(0).u32(0);
  const layerMaskLength = writer.reserveU32();
  const layerMaskStart = writer.length;
  const layerInfoLength = writer.reserveU32();
  const layerInfoStart = writer.length;
  writer.i16(1);
  writer.i32(0).i32(0).i32(1).i32(2).u16(4);
  for (const id of [0, 1, 2, -1]) writer.i16(id).u32(4);
  writer.ascii("8BIM").ascii("norm").u8(255).u8(0).u8(0).u8(0);
  const extraLength = writer.reserveU32();
  const extraStart = writer.length;
  writer.u32(0).u32(0);
  writer.u8(2).ascii("RG").u8(0);
  writer.ascii("8BIM").ascii("luni");
  const unicodeLength = writer.reserveU32();
  const unicodeStart = writer.length;
  writer.u32(9);
  for (const character of "Red Green") writer.u16(character.charCodeAt(0));
  writer.patchU32(unicodeLength, writer.length - unicodeStart);
  writer.ascii("8BIM").ascii("lyid").u32(4).u32(42);
  writer.patchU32(extraLength, writer.length - extraStart);
  for (const plane of [
    [255, 0],
    [0, 255],
    [0, 0],
    [255, 128],
  ])
    writer.u16(0).bytes(plane);
  writer.patchU32(layerInfoLength, writer.length - layerInfoStart);
  writer.patchU32(layerMaskLength, writer.length - layerMaskStart);
  writer.u16(0).bytes([255, 0]).bytes([0, 255]).bytes([0, 0]);
  return writer.buffer();
}

async function sha256Identity(bytes: Uint8Array): Promise<string> {
  const exact = new Uint8Array(bytes).buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", exact));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

class BinaryWriter {
  readonly values: number[] = [];

  get length(): number {
    return this.values.length;
  }

  ascii(value: string): this {
    return this.bytes([...value].map((character) => character.charCodeAt(0)));
  }

  bytes(values: readonly number[]): this {
    this.values.push(...values);
    return this;
  }

  zero(count: number): this {
    return this.bytes(Array.from({ length: count }, () => 0));
  }

  u8(value: number): this {
    this.values.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    const unsigned = value & 0xffff;
    return this.bytes([unsigned >>> 8, unsigned]);
  }

  i16(value: number): this {
    return this.u16(value);
  }

  u32(value: number): this {
    return this.bytes([value >>> 24, value >>> 16, value >>> 8, value]);
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  reserveU32(): number {
    const offset = this.length;
    this.u32(0);
    return offset;
  }

  patchU32(offset: number, value: number): void {
    this.values[offset] = (value >>> 24) & 0xff;
    this.values[offset + 1] = (value >>> 16) & 0xff;
    this.values[offset + 2] = (value >>> 8) & 0xff;
    this.values[offset + 3] = value & 0xff;
  }

  buffer(): ArrayBuffer {
    return new Uint8Array(this.values).buffer;
  }
}
