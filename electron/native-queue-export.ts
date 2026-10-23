import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { RenderJobManifest } from "../src/core/rendering/render-queue.js";
import { EMPTY_RENDER_MEDIA_SNAPSHOT } from "../src/render-queue/render-media-codec.js";
import {
  type NativeProjectExportEvent,
  NativeProjectExportProcess,
} from "./native-project-export-process.js";
import type { NativeProjectExportExpectation } from "./native-project-export-protocol.js";
import {
  nativeQueueConfigurationIdentity,
  type prepareNativeQueueProject,
} from "./native-queue-project.js";

export interface NativeQueueExportRuntime {
  renderer: string;
  ffmpeg: string;
  ffprobe: string;
  compiler?: string;
}

/** Bind one private output process to the captured job and the prepared project receipts. */
export async function startNativeQueueExport(options: {
  manifest: RenderJobManifest;
  prepared: Awaited<ReturnType<typeof prepareNativeQueueProject>>;
  outputId: string;
  destination: string;
  runtime: NativeQueueExportRuntime;
  signal?: AbortSignal;
  onEvent?: (event: NativeProjectExportEvent) => void;
}): Promise<NativeProjectExportProcess> {
  const { manifest, prepared, runtime } = structuredClone({
    manifest: options.manifest,
    prepared: options.prepared,
    runtime: options.runtime,
  });
  const output = manifest.outputs.find((output) => output.id === options.outputId);
  if (
    !output ||
    (output.kind === "mp4" && output.codec !== "h264") ||
    (output.kind === "still" && output.format !== "png")
  )
    throw new Error("Unsupported native queue output");
  const expected: NativeProjectExportExpectation = {
    format: output.kind === "mp4" ? "mp4" : output.kind === "still" ? "png" : "png-sequence",
    projectSha256: prepared.projectSha256,
    output: options.destination,
    width: manifest.width,
    height: manifest.height,
    frameRate: manifest.frameRate,
    startFrame: output.kind === "still" ? output.frame : manifest.startFrame,
    frames: output.kind === "still" ? 1 : manifest.endFrameExclusive - manifest.startFrame,
    bitrate: output.kind === "mp4" ? Math.round(output.bitrateMbps * 1000000) : 20000000,
    includeAudio: output.kind === "mp4" && output.includeAudio,
  };
  if (
    expected.startFrame < manifest.startFrame ||
    expected.startFrame + expected.frames > manifest.endFrameExclusive
  )
    throw new Error("Native output frame range is outside its job");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (
    prepared.configurationSha256 !== nativeQueueConfigurationIdentity(manifest) ||
    prepared.authoredSnapshotSha256 !== hash(manifest.projectSnapshot) ||
    prepared.mediaSnapshotSha256 !==
      hash(manifest.renderMediaSnapshot ?? EMPTY_RENDER_MEDIA_SNAPSHOT)
  )
    throw new Error("Native queue inputs differ from their preparation receipts");
  for (const [path, digest] of [
    [prepared.project, prepared.projectSha256],
    [prepared.request, prepared.requestSha256],
  ]) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { signal: options.signal }))
      hash.update(chunk);
    if (hash.digest("hex") !== digest) throw new Error("Prepared native queue input changed");
  }
  options.signal?.throwIfAborted();
  return new NativeProjectExportProcess({
    executable: runtime.renderer,
    args: [
      "export",
      "--project",
      prepared.project,
      "--composition",
      manifest.compositionId,
      "--request",
      prepared.request,
      "--out",
      expected.output,
      "--format",
      expected.format,
      "--start-frame",
      String(expected.startFrame),
      "--frames",
      String(expected.frames),
      "--width",
      String(expected.width),
      "--height",
      String(expected.height),
      "--fps-numerator",
      String(expected.frameRate.numerator),
      "--fps-denominator",
      String(expected.frameRate.denominator),
      "--bitrate",
      String(expected.bitrate),
      "--aa",
      manifest.antiAliasing ?? "off",
      "--ffmpeg",
      runtime.ffmpeg,
      "--ffprobe",
      runtime.ffprobe,
      "--control-stdin",
      "--render-export-frames",
      String(Math.max(4096, expected.frames)),
      "--max-encoder-frames",
      String(Math.max(1_000_000, expected.frames)),
      ...(expected.format === "mp4"
        ? []
        : ["--image-receipts", `${expected.output}.receipts.jsonl`]),
      ...(runtime.compiler ? ["--dxcompiler", runtime.compiler] : []),
      ...(expected.includeAudio ? [] : ["--no-audio"]),
      ...prepared.runtimeArguments,
    ],
    expected,
    onEvent: options.onEvent,
  });
}
