export type RenderHostOutputRequest =
  | {
      type: "startMp4";
      jobId: string;
      leaseId: string;
      outputId: string;
      pixelFormat: "bgra" | "rgba";
      videoBitrateBps: number;
      audio?: { sampleRate: number; channels: 2; frameCount: number };
    }
  | {
      type: "writeMp4Frame";
      jobId: string;
      leaseId: string;
      outputId: string;
      pixels: ArrayBuffer;
    }
  | {
      type: "writeMp4Audio";
      jobId: string;
      leaseId: string;
      outputId: string;
      samples: ArrayBuffer;
    }
  | {
      type: "finishMp4";
      jobId: string;
      leaseId: string;
      outputId: string;
    }
  | {
      type: "writePng";
      jobId: string;
      leaseId: string;
      outputId: string;
      frame: number;
      pixels: ArrayBuffer;
    };

export function parseRenderHostOutputRequest(value: unknown): RenderHostOutputRequest {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("RenderHost output request is invalid");
  const shared = {
    jobId: boundedId(value.jobId, "job"),
    leaseId: boundedId(value.leaseId, "lease"),
    outputId: boundedId(value.outputId, "output"),
  };
  if (value.type === "startMp4") {
    exactKeys(value, [
      "type",
      "jobId",
      "leaseId",
      "outputId",
      "pixelFormat",
      "videoBitrateBps",
      ...(value.audio === undefined ? [] : ["audio"]),
    ]);
    if (value.pixelFormat !== "bgra" && value.pixelFormat !== "rgba")
      throw new Error("RenderHost MP4 pixel format is invalid");
    if (
      !Number.isSafeInteger(value.videoBitrateBps) ||
      Number(value.videoBitrateBps) < 64_000 ||
      Number(value.videoBitrateBps) > 1_000_000_000
    )
      throw new Error("RenderHost MP4 video bitrate is outside supported bounds");
    return {
      type: "startMp4",
      ...shared,
      pixelFormat: value.pixelFormat,
      videoBitrateBps: Number(value.videoBitrateBps),
      ...(value.audio === undefined ? {} : { audio: audioOptions(value.audio) }),
    };
  }
  if (value.type === "writeMp4Frame") {
    exactKeys(value, ["type", "jobId", "leaseId", "outputId", "pixels"]);
    if (!(value.pixels instanceof ArrayBuffer))
      throw new Error("RenderHost MP4 frame must be an ArrayBuffer");
    return { type: "writeMp4Frame", ...shared, pixels: value.pixels };
  }
  if (value.type === "writeMp4Audio") {
    exactKeys(value, ["type", "jobId", "leaseId", "outputId", "samples"]);
    if (
      !(value.samples instanceof ArrayBuffer) ||
      value.samples.byteLength === 0 ||
      value.samples.byteLength > 8 * 1024 * 1024 ||
      value.samples.byteLength % (2 * Float32Array.BYTES_PER_ELEMENT) !== 0
    )
      throw new Error("RenderHost MP4 audio must be bounded interleaved Float32 stereo PCM");
    return { type: "writeMp4Audio", ...shared, samples: value.samples };
  }
  if (value.type === "finishMp4") {
    exactKeys(value, ["type", "jobId", "leaseId", "outputId"]);
    return { type: "finishMp4", ...shared };
  }
  if (value.type === "writePng") {
    exactKeys(value, ["type", "jobId", "leaseId", "outputId", "frame", "pixels"]);
    if (!Number.isSafeInteger(value.frame) || Number(value.frame) < 0)
      throw new Error("RenderHost PNG frame index is invalid");
    if (!(value.pixels instanceof ArrayBuffer))
      throw new Error("RenderHost PNG payload must be an ArrayBuffer");
    return { type: "writePng", ...shared, frame: Number(value.frame), pixels: value.pixels };
  }
  throw new Error("RenderHost output request type is invalid");
}

function audioOptions(value: unknown): { sampleRate: number; channels: 2; frameCount: number } {
  if (!isRecord(value)) throw new Error("RenderHost MP4 audio options are invalid");
  exactKeys(value, ["sampleRate", "channels", "frameCount"]);
  if (
    !Number.isSafeInteger(value.sampleRate) ||
    Number(value.sampleRate) < 8_000 ||
    Number(value.sampleRate) > 192_000 ||
    value.channels !== 2 ||
    !Number.isSafeInteger(value.frameCount) ||
    Number(value.frameCount) < 1 ||
    Number(value.frameCount) > 86_400 * 192_000
  )
    throw new Error("RenderHost MP4 audio options are outside supported bounds");
  return {
    sampleRate: Number(value.sampleRate),
    channels: 2,
    frameCount: Number(value.frameCount),
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key)))
    throw new Error("RenderHost output request fields are invalid");
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0"))
    throw new Error(`RenderHost ${label} ID is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
