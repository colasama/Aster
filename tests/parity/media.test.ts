// @vitest-environment happy-dom

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { validateProjectDocument } from "../../src/core/project/project-file";
import { mediaBytesIdentity } from "../../src/importers/media-import-identity";
import { validatePersistedMediaImports } from "../../src/importers/media-import-persistence-codec";
import { hydratePersistedMediaImports } from "../../src/importers/media-import-persistence-hydration";
import { mediaImportRuntime } from "../../src/importers/media-import-runtime";
import assets from "./assets/media-assets.json";
import { buildMediaCases, buildUnsupportedExrCase } from "./generators/media";

afterEach(() => mediaImportRuntime.clear());

describe("parity media corpus", () => {
  it("separates unique source identities from repeated output-frame hold boundaries", () => {
    const cases = buildMediaCases();
    const identity = cases.find((value) => value.case.id === "media-image-sequence-identity");
    const holds = cases.find((value) => value.case.id === "media-image-sequence");
    expect(identity?.case.frames).toEqual([0, 1, 2, 3]);
    expect(identity?.case.sequence).toBe(true);
    expect(identity?.project.compositions[0].frameRate).toEqual({ numerator: 2, denominator: 1 });
    expect(holds?.case.features).toContain("media:hold-boundaries");
    expect(holds?.case.sequence).toBeUndefined();
    expect(
      cases
        .filter((value) => value.case.id.startsWith("video-"))
        .every((value) => value.case.sequence),
    ).toBe(true);
  });
  it("keeps real linear EXR bytes outside the currently supported still-media sidecar", async () => {
    const { project } = buildUnsupportedExrCase();
    expect(project.sources[0].name).toBe("pattern.exr");
    expect(project.sources[0].mimeType).toBe("image/x-exr");
    expect(project.sources[0].interpretation.colorSpace).toBe("linear");
    expect(assets.assets["pattern.exr"].linearSamples[0].rgb[0]).toBeCloseTo(0.062470436, 6);
    expect(assets.assets["pattern.exr"].linearSamples[1].rgb[0]).toBeCloseTo(0.937514305, 6);
    expect(() => validatePersistedMediaImports(project.mediaImports)).toThrow(
      "extension is unsupported for still media",
    );
    await expect(hydratePersistedMediaImports(project, project.mediaImports)).rejects.toThrow(
      "extension is unsupported for still media",
    );
    expect(mediaImportRuntime.has(project.sources[0].id)).toBe(false);
  });

  it("builds byte-stable projects with valid source references and mandatory inline sidecars", () => {
    const cases = buildMediaCases();
    expect(cases).toEqual(buildMediaCases());
    expect(new Set(cases.map((item) => item.case.id)).size).toBe(cases.length);
    for (const generated of cases) {
      expect(() => validateProjectDocument(structuredClone(generated.project))).not.toThrow();
      const sidecar = validatePersistedMediaImports(generated.project.mediaImports);
      expect(sidecar.entries).toHaveLength(generated.project.sources.length);
      for (const source of generated.project.sources) {
        expect(source.dataUrl).toBeUndefined();
        expect(source.runtimeUrl).toBeUndefined();
        expect(source.relativePath).toBeUndefined();
        const entry = sidecar.entries.find((candidate) => candidate.sourceId === source.id);
        expect(entry?.contentIdentity).toBe(source.contentIdentity);
        const payload = sidecar.payloads.find((candidate) => candidate.id === entry?.payloadId);
        expect(payload?.kind).toBe(source.kind);
        if (!payload) throw new Error(`Missing payload for ${source.name}`);
        const storages =
          payload.kind === "imageSequence"
            ? payload.frames.map((frame) => frame.storage)
            : [payload.storage];
        for (const storage of storages) {
          expect(storage.kind).toBe("inline");
          if (storage.kind !== "inline") throw new Error("Corpus must not reference local files");
          expect(mediaBytesIdentity(Buffer.from(storage.data, "base64"))).toBe(
            storage.byteIdentity,
          );
        }
      }
    }
  });

  it("hydrates every source including actual SVG paths, PSD pixels and image sequence frames", async () => {
    for (const { project } of buildMediaCases()) {
      await hydratePersistedMediaImports(project, project.mediaImports);
      for (const source of project.sources) {
        expect(mediaImportRuntime.error(source.id)).toBeUndefined();
        const runtime = mediaImportRuntime.get(source.id);
        expect(runtime?.kind).toBe(source.kind);
        expect(source.runtimeUrl).toBeTruthy();
        if (runtime?.kind === "psd") {
          expect(runtime.pixels).toHaveLength(96 * 64 * 4);
          expect(new Set(runtime.pixels).size).toBeGreaterThan(100);
        }
        if (runtime?.kind === "imageSequence") {
          expect(runtime.selection.frames.map((frame) => frame.frame)).toEqual([0, 1, 2, 3]);
          expect(
            new Set(runtime.selection.frames.map((frame) => frame.file.byteIdentity)).size,
          ).toBe(4);
        }
      }
    }
  });

  it("rejects tampered inline bytes instead of silently registering a missing texture", async () => {
    const { project } = buildMediaCases()[0];
    const payload = project.mediaImports?.payloads[0];
    if (!payload || payload.kind === "imageSequence" || payload.storage.kind !== "inline")
      throw new Error("Missing inline fixture");
    const bytes = Buffer.from(payload.storage.data, "base64");
    bytes[0] ^= 1;
    payload.storage.data = bytes.toString("base64");
    await expect(hydratePersistedMediaImports(project, project.mediaImports)).rejects.toThrow(
      "identity mismatch",
    );
    expect(mediaImportRuntime.has(project.sources[0].id)).toBe(false);
  });

  it("covers both fractional rates and preserves non-monotonic GOP seek requests", () => {
    const cases = buildMediaCases();
    for (const numerator of [24_000, 30_000]) {
      const item = cases.find((candidate) => candidate.case.id === `video-${numerator}-1001-seek`);
      if (!item) throw new Error("Missing fractional-rate seek case");
      expect(item.case.sequence).toBe(true);
      expect(item.case.frames).toEqual([36, 11, 12, 0, 71, 24, 23, 48, 47, 1]);
      expect(item.project.compositions[0].frameRate).toEqual({ numerator, denominator: 1001 });
      expect(item.project.sources[0].interpretation.frameRate).toEqual({
        numerator,
        denominator: 1001,
      });
      expect(item.case.tolerance).toBe("decode");
    }
  });
});

describe("procedural asset provenance", () => {
  it("binds every byte payload to SHA-256 and the installed generator provenance", () => {
    expect(assets.provenance.generator).toBe("scripts/parity-media-assets.mjs");
    expect(assets.provenance.ffmpeg.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const asset of Object.values(assets.assets)) {
      const bytes = Buffer.from(asset.data, "base64");
      expect(bytes.length).toBe(asset.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    }
  });

  it("contains actual PNG, JPEG, EXR, PSD and uncompressed stereo PCM signatures", () => {
    expect(
      Buffer.from(assets.assets["pattern.png"].data, "base64").subarray(0, 8).toString("hex"),
    ).toBe("89504e470d0a1a0a");
    expect(
      Buffer.from(assets.assets["pattern.jpg"].data, "base64").subarray(0, 2).toString("hex"),
    ).toBe("ffd8");
    expect(Buffer.from(assets.assets["pattern.exr"].data, "base64").readUInt32LE(0)).toBe(
      20_000_630,
    );
    expect(Buffer.from(assets.assets["pattern.psd"].data, "base64").subarray(0, 4).toString()).toBe(
      "8BPS",
    );
    const wav = Buffer.from(assets.assets["pulse.wav"].data, "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 16).toString()).toBe("WAVEfmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt32LE(40)).toBe(96_000 * 4);
    expect(wav.readInt16LE(100)).not.toBe(0);
  });

  it("encodes distinct source frame identities in actual sequence pixels", () => {
    const ids = [0, 1, 2, 3].map((frame) => {
      const name = `sequence-${String(frame).padStart(4, "0")}.png` as keyof typeof assets.assets;
      const png = Buffer.from(assets.assets[name].data, "base64");
      const chunks: Buffer[] = [];
      for (let offset = 8; offset < png.length; ) {
        const length = png.readUInt32BE(offset);
        if (png.subarray(offset + 4, offset + 8).toString() === "IDAT")
          chunks.push(png.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      const scanlines = inflateSync(Buffer.concat(chunks));
      let decoded = 0;
      for (let bit = 0; bit < 7; bit += 1)
        if (scanlines[20 * (96 * 4 + 1) + 1 + (12 + bit * 12) * 4] > 128) decoded |= 1 << bit;
      return decoded;
    });
    expect(ids).toEqual([0, 1, 2, 3]);
  });

  it("records exact ffprobe rates, fixed GOPs and successful decoded identity proof", () => {
    for (const name of ["barcode-24000-1001.mp4", "barcode-30000-1001.mp4"] as const) {
      const video = assets.assets[name];
      expect(Buffer.from(video.data, "base64").subarray(4, 8).toString()).toBe("ftyp");
      expect(video.stream.codec_name).toBe("h264");
      expect(video.stream.pix_fmt).toBe("yuv420p");
      expect(video.stream.color_space).toBe("bt709");
      expect(video.stream.color_range).toBe("tv");
      expect(video.stream.avg_frame_rate).toBe(`${video.frameRate.numerator}/1001`);
      expect(video.stream.r_frame_rate).toBe(`${video.frameRate.numerator}/1001`);
      expect(video.stream.nb_frames).toBe("72");
      expect(video.keyframes).toEqual([0, 12, 24, 36, 48, 60]);
      expect(video.decodedFrameIdentities).toEqual(Array.from({ length: 72 }, (_, frame) => frame));
    }
  });
});
