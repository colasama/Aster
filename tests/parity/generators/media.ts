import {
  type FootageSource,
  setLayerSizeAndCenterAnchor,
  staticValue,
} from "../../../src/core/types";
import {
  mediaBytesIdentity,
  mediaTextIdentity,
} from "../../../src/importers/media-import-identity";
import type {
  PersistedMediaEntry,
  PersistedMediaPayload,
  PersistedMediaStorage,
} from "../../../src/importers/media-import-persistence-codec";
import mediaAssets from "../assets/media-assets.json";
import type { GeneratedCase } from "../types";
import { caseFor, fixture } from "./base";

type AssetName = keyof typeof mediaAssets.assets;
type MediaProject = GeneratedCase["project"];

function storageFor(name: AssetName): PersistedMediaStorage {
  const asset = mediaAssets.assets[name];
  const bytes = Uint8Array.from(atob(asset.data), (character) => character.charCodeAt(0));
  return { kind: "inline", byteIdentity: mediaBytesIdentity(bytes), data: asset.data };
}

function install(
  project: MediaProject,
  source: FootageSource,
  entry: PersistedMediaEntry,
  payload: PersistedMediaPayload,
): void {
  project.sources.push(source);
  project.mediaImports = {
    version: 1,
    entries: [...(project.mediaImports?.entries ?? []), entry],
    payloads: [...(project.mediaImports?.payloads ?? []), payload],
  };
}

/** Installs the shared PCM fixture through the same persisted sidecar as imported project audio. */
export function attachAudioFixture(
  project: MediaProject,
): Extract<FootageSource, { kind: "audio" }> {
  const storage = storageFor("pulse.wav");
  if (storage.kind !== "inline") throw new Error("Parity media must be self-contained");
  const source: Extract<FootageSource, { kind: "audio" }> = {
    id: "parity-audio-source",
    name: "pulse.wav",
    kind: "audio",
    mimeType: "audio/wav",
    contentIdentity: storage.byteIdentity,
    interpretation: { alpha: "ignore", colorSpace: "srgb" },
    duration: 2,
    channels: 2,
    sampleRate: 48_000,
    streamIndex: 0,
  };
  const payloadId = "parity-audio-payload";
  install(
    project,
    source,
    { sourceId: source.id, kind: "audio", contentIdentity: source.contentIdentity, payloadId },
    {
      id: payloadId,
      kind: "audio",
      contentIdentity: source.contentIdentity,
      mimeType: source.mimeType,
      extension: ".wav",
      storage,
    },
  );
  return source;
}

function footageCase(name: AssetName, kind: "still" | "video", seek = false): GeneratedCase {
  const extension = name.slice(name.lastIndexOf("."));
  const id =
    kind === "still"
      ? `media-${extension.slice(1)}`
      : `video-${name.includes("24000") ? "24000" : "30000"}-1001${seek ? "-seek" : ""}`;
  const { project, composition, layer } = fixture(id);
  const asset = mediaAssets.assets[name];
  const storage = storageFor(name);
  if (storage.kind !== "inline" || !("width" in asset))
    throw new Error(`Invalid visual fixture ${name}`);
  const common = {
    id: `source-${id}`,
    name,
    mimeType: asset.mimeType,
    contentIdentity: storage.byteIdentity,
    width: asset.width,
    height: asset.height,
    interpretation: {
      alpha: "straight" as const,
      colorSpace: extension === ".exr" ? ("linear" as const) : ("srgb" as const),
    },
  };
  let source: FootageSource;
  const features = [
    `layer:${kind === "still" ? "image" : "video"}`,
    `media:${extension === ".jpg" ? "jpeg" : extension.slice(1)}`,
  ];
  let frames = [0, 15, 30, 59];
  if (kind === "video" && "frameRate" in asset) {
    source = {
      ...common,
      kind: "video",
      duration: asset.duration,
      interpretation: { ...common.interpretation, frameRate: { ...asset.frameRate } },
    };
    composition.frameRate = { ...asset.frameRate };
    composition.duration = asset.duration;
    composition.workArea = { start: 0, end: asset.duration };
    features.push(
      `video:${asset.frameRate.numerator}/${asset.frameRate.denominator}`,
      "media:frame-identity",
    );
    if (seek) features.push("video:seek-boundaries");
    frames = seek
      ? [36, 11, 12, 0, 71, 24, 23, 48, 47, 1]
      : [0, 11, 12, 13, 23, 24, 25, 47, 48, 49, 70, 71];
  } else source = { ...common, kind: "still" };
  const payloadId = `payload-${id}`;
  install(
    project,
    source,
    { sourceId: source.id, kind, contentIdentity: source.contentIdentity, payloadId },
    {
      id: payloadId,
      kind,
      contentIdentity: source.contentIdentity,
      mimeType: source.mimeType,
      extension,
      storage,
    },
  );
  const visual = layer(kind === "still" ? "image" : "video", name);
  visual.sourceId = source.id;
  visual.outPoint = composition.duration;
  setLayerSizeAndCenterAnchor(visual, [asset.width, asset.height]);
  visual.transform.scale = [staticValue(200), staticValue(200), staticValue(100)];
  composition.layers.push(visual);
  return caseFor(id, project, features, {
    frames,
    tolerance: kind === "video" ? "decode" : "gpu",
    ...(kind === "video" ? { sequence: true } : {}),
  });
}

function advancedCase(kind: "svg" | "psd", layered = false): GeneratedCase {
  const id = `media-${kind}${layered ? "-layer" : ""}`;
  const { project, composition, layer } = fixture(id);
  const name = `pattern.${kind}` as const;
  const storage = storageFor(name);
  if (storage.kind !== "inline") throw new Error("Parity media must be self-contained");
  const asset = mediaAssets.assets[name];
  const importMode = layered ? "compositionRetainLayerSizes" : "merged";
  const layerKey = layered ? "layer-42" : "merged";
  const source: FootageSource = {
    id: `source-${id}`,
    name,
    mimeType: asset.mimeType,
    contentIdentity:
      kind === "psd" ? `${storage.byteIdentity}:${importMode}:${layerKey}` : storage.byteIdentity,
    interpretation: { alpha: "straight", colorSpace: "srgb" },
    width: 96,
    height: 64,
    ...(kind === "psd" ? { kind: "psd", layerCount: 1 } : { kind: "svg" }),
  };
  const payloadId = `payload-${id}`;
  if (kind === "psd") {
    install(
      project,
      source,
      {
        sourceId: source.id,
        kind,
        contentIdentity: source.contentIdentity,
        payloadId,
        documentIdentity: storage.byteIdentity,
        importMode,
        layerKey,
      },
      { id: payloadId, kind, documentIdentity: storage.byteIdentity, storage },
    );
  } else {
    install(
      project,
      source,
      { sourceId: source.id, kind, contentIdentity: source.contentIdentity, payloadId },
      {
        id: payloadId,
        kind,
        contentIdentity: source.contentIdentity,
        width: 96,
        height: 64,
        storage,
      },
    );
  }
  const visual = layer("image", name);
  visual.sourceId = source.id;
  setLayerSizeAndCenterAnchor(visual, [96, 64]);
  visual.transform.scale = [staticValue(200), staticValue(200), staticValue(100)];
  composition.layers.push(visual);
  return caseFor(id, project, [
    "layer:image",
    `media:${kind}`,
    ...(kind === "psd" ? [`psd:${importMode}`] : []),
  ]);
}

function sequenceCase(identity = false): GeneratedCase {
  const id = `media-image-sequence${identity ? "-identity" : ""}`;
  const { project, composition, layer } = fixture(id);
  if (identity) composition.frameRate = { numerator: 2, denominator: 1 };
  const frames = [0, 1, 2, 3].map((frame) => {
    const name = `sequence-${String(frame).padStart(4, "0")}.png` as AssetName;
    const asset = mediaAssets.assets[name];
    return {
      frame,
      name,
      size: asset.byteLength,
      lastModified: 0,
      type: asset.mimeType,
      storage: storageFor(name),
    };
  });
  const source: Extract<FootageSource, { kind: "imageSequence" }> = {
    id: "source-image-sequence",
    name: "sequence-[####].png",
    kind: "imageSequence",
    mimeType: "image/png",
    contentIdentity: mediaTextIdentity(
      frames
        .map((frame) => `${frame.name}:${mediaAssets.assets[frame.name as AssetName].sha256}`)
        .join("\n"),
    ),
    interpretation: {
      alpha: "straight",
      colorSpace: "srgb",
      frameRate: { numerator: 2, denominator: 1 },
    },
    width: 96,
    height: 64,
    pattern: "sequence-[####].png",
    startFrame: 0,
    endFrame: 3,
  };
  const payloadId = "payload-image-sequence";
  install(
    project,
    source,
    { sourceId: source.id, kind: source.kind, contentIdentity: source.contentIdentity, payloadId },
    {
      id: payloadId,
      kind: source.kind,
      contentIdentity: source.contentIdentity,
      pattern: source.pattern,
      prefix: "sequence-",
      extension: ".png",
      padding: 4,
      startFrame: 0,
      endFrame: 3,
      missingFrames: [],
      frameRate: { numerator: 2, denominator: 1 },
      missingFramePolicy: "error",
      loop: false,
      frames,
    },
  );
  const image = layer("image", source.name);
  image.sourceId = source.id;
  setLayerSizeAndCenterAnchor(image, [96, 64]);
  image.transform.scale = [staticValue(200), staticValue(200), staticValue(100)];
  composition.layers.push(image);
  return caseFor(
    id,
    project,
    [
      "layer:image",
      "media:image-sequence",
      identity ? "media:frame-identity" : "media:hold-boundaries",
    ],
    identity
      ? { frames: [0, 1, 2, 3], sequence: true }
      : { frames: [0, 14, 15, 29, 30, 44, 45, 59] },
  );
}

export function buildMediaCases(): GeneratedCase[] {
  const { project, composition, layer } = fixture("media-audio");
  const source = attachAudioFixture(project);
  const audio = layer("audio", source.name);
  audio.sourceId = source.id;
  audio.audioEnabled = true;
  composition.layers.push(audio);
  return [
    footageCase("pattern.png", "still"),
    footageCase("pattern.jpg", "still"),
    caseFor("media-audio", project, ["layer:audio", "media:audio"]),
    footageCase("barcode-24000-1001.mp4", "video"),
    footageCase("barcode-24000-1001.mp4", "video", true),
    footageCase("barcode-30000-1001.mp4", "video"),
    footageCase("barcode-30000-1001.mp4", "video", true),
    sequenceCase(),
    sequenceCase(true),
    advancedCase("svg"),
    advancedCase("psd"),
    advancedCase("psd", true),
  ];
}

/** EXR bytes are preserved for native decode; the current project sidecar explicitly rejects EXR. */
export function buildUnsupportedExrCase(): GeneratedCase {
  return footageCase("pattern.exr", "still");
}
