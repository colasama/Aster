import {
  type AudioSourceDecoder,
  alignedAudioFrameCount,
  decodeAudibleSources,
  EXPORT_AUDIO_SAMPLE_RATE,
  streamCompositionAudio,
} from "../../core/audio-export";
import { validateProjectDocument } from "../../core/project-file";
import { frameTimeAtIndex } from "../../core/render-export";
import type { RenderJobManifest } from "../../core/render-queue";
import type { Composition, Project } from "../../core/types";
import type {
  DesktopRenderHostAssignment,
  DesktopRenderHostControl,
  DesktopRenderHostOutputRequest,
  DesktopRenderHostReport,
  Mp4PixelFormat,
} from "../../desktop/api";
import type { RawVideoFrame } from "../../renderer/frame-readback";

export interface ValidatedRenderHostAssignment {
  assignment: DesktopRenderHostAssignment;
  manifest: RenderJobManifest;
  composition: Composition;
  project: Project;
  synchronizeVideo: boolean;
}

interface RenderHostFrameLoopOptions {
  assignment: ValidatedRenderHostAssignment;
  pixelFormat: Mp4PixelFormat;
  audioDecoder?: AudioSourceDecoder;
  renderFrame(frame: number, time: number): Promise<RawVideoFrame>;
  encodePng(frame: RawVideoFrame): Promise<ArrayBuffer>;
  output(request: DesktopRenderHostOutputRequest): Promise<unknown>;
  report(report: DesktopRenderHostReport): Promise<void>;
  requestedControl(): "pause" | "cancel" | undefined;
  now?(): number;
}

export type RenderHostFrameLoopResult = "completed" | "paused" | "cancelled";

/** Evaluates beauty frames sequentially while bounded audio writes run with independent backpressure. */
export async function runRenderHostFrameLoop(
  options: RenderHostFrameLoopOptions,
): Promise<RenderHostFrameLoopResult> {
  const validated = options.assignment;
  const { assignment, manifest } = validated;
  const shared = { jobId: assignment.jobId, leaseId: assignment.leaseId };
  const initialControl = options.requestedControl();
  if (initialControl) return await reportControlBoundary(options.report, shared, initialControl);
  const mp4Outputs = manifest.outputs.filter((output) => output.kind === "mp4");
  const audioOutputs = mp4Outputs.filter((output) => output.includeAudio);
  const pngOutputs = manifest.outputs.filter(
    (output) => output.kind === "pngSequence" || output.kind === "still",
  );
  const audio = await prepareAudioPipeline(options, audioOutputs.length > 0);
  for (const output of mp4Outputs)
    await options.output({
      type: "startMp4",
      ...shared,
      outputId: output.id,
      pixelFormat: options.pixelFormat,
      ...(output.includeAudio && audio
        ? {
            audio: {
              sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
              channels: 2 as const,
              frameCount: audio.frameCount,
            },
          }
        : {}),
    });

  await options.report({ type: "prepared", ...shared });
  let audioAborted = false;
  let audioFailure: { reason: unknown } | undefined;
  const audioPipeline = audio
    ? streamCompositionAudio(
        audio.project,
        audio.composition,
        audio.decoded,
        audio.frameCount,
        async (samples) => {
          await Promise.all(
            audioOutputs.map((output) =>
              options.output({
                type: "writeMp4Audio",
                ...shared,
                outputId: output.id,
                samples: samples.buffer as ArrayBuffer,
              }),
            ),
          );
        },
        () => audioAborted || options.requestedControl() !== undefined,
        EXPORT_AUDIO_SAMPLE_RATE,
        frameTimeAtIndex(manifest.startFrame, manifest.frameRate),
      ).catch((error: unknown) => {
        audioFailure = { reason: error };
        audioAborted = true;
        return -1;
      })
    : Promise.resolve(0);
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const totalFrames = manifest.endFrameExclusive - manifest.startFrame;
  try {
    for (let frame = manifest.startFrame; frame < manifest.endFrameExclusive; frame += 1) {
      throwAudioFailure(audioFailure);
      const beforeFrame = options.requestedControl();
      if (beforeFrame)
        return await stopAtControlBoundary(
          options.report,
          shared,
          beforeFrame,
          () => {
            audioAborted = true;
          },
          audioPipeline,
        );
      const raw = await options.renderFrame(frame, frameTimeAtIndex(frame, manifest.frameRate));
      validateRawFrame(raw, manifest, options.pixelFormat);

      const needsPng = pngOutputs.some(
        (output) => output.kind === "pngSequence" || output.frame === frame,
      );
      if (needsPng) {
        const pixels = await options.encodePng(raw);
        for (const output of pngOutputs) {
          if (output.kind === "still" && output.frame !== frame) continue;
          await options.output({
            type: "writePng",
            ...shared,
            outputId: output.id,
            frame,
            pixels,
          });
        }
      }
      for (const output of mp4Outputs)
        await options.output({
          type: "writeMp4Frame",
          ...shared,
          outputId: output.id,
          pixels: raw.pixels,
        });

      const completedFrames = frame - manifest.startFrame + 1;
      const elapsedMs = Math.max(0, now() - startedAt);
      await options.report({
        type: "progress",
        ...shared,
        progress: {
          completedFrames,
          totalFrames,
          elapsedMs,
          estimatedRemainingMs:
            completedFrames < totalFrames
              ? (elapsedMs / completedFrames) * (totalFrames - completedFrames)
              : 0,
        },
      });
    }

    const afterLastFrame = options.requestedControl();
    if (afterLastFrame)
      return await stopAtControlBoundary(
        options.report,
        shared,
        afterLastFrame,
        () => {
          audioAborted = true;
        },
        audioPipeline,
      );
    const completedAudioFrames = await audioPipeline;
    throwAudioFailure(audioFailure);
    const afterAudio = options.requestedControl();
    if (afterAudio)
      return await stopAtControlBoundary(
        options.report,
        shared,
        afterAudio,
        () => {
          audioAborted = true;
        },
        audioPipeline,
      );
    if (audio && completedAudioFrames !== audio.frameCount)
      throw new Error(
        "RenderHost audio pipeline stopped before the rational frame range completed",
      );
    for (const output of mp4Outputs)
      await options.output({ type: "finishMp4", ...shared, outputId: output.id });
    const afterEncoders = options.requestedControl();
    if (afterEncoders)
      return await stopAtControlBoundary(
        options.report,
        shared,
        afterEncoders,
        () => {
          audioAborted = true;
        },
        audioPipeline,
      );
    await options.report({ type: "completed", ...shared });
    return "completed";
  } catch (error) {
    audioAborted = true;
    // Do not let an in-flight PCM IPC write race the worker's failure cleanup. The audio promise
    // owns its own rejection capture above, so draining it here is bounded by output backpressure
    // and preserves the original frame/output failure as the session error.
    await audioPipeline;
    throw error;
  }
}

/** Parses the immutable snapshot and rejects any manifest/render-document drift before GPU work. */
export function validateRenderHostAssignment(
  assignment: DesktopRenderHostAssignment,
): ValidatedRenderHostAssignment {
  if (assignment.jobId !== assignment.manifest.id)
    throw new Error("RenderHost assignment job does not match its manifest");
  const project = validateProjectDocument(JSON.parse(assignment.manifest.projectSnapshot));
  const composition = project.compositions.find(
    (candidate) => candidate.id === assignment.manifest.compositionId,
  );
  if (!composition) throw new Error("RenderHost composition is missing from its project snapshot");
  assertManifestComposition(assignment.manifest, composition);
  return {
    assignment,
    manifest: assignment.manifest,
    project,
    composition,
    synchronizeVideo: compositionUsesVideo(project, composition),
  };
}

export function mergeRenderHostControl(
  current: "pause" | "cancel" | undefined,
  incoming: DesktopRenderHostControl,
  assignment: Pick<DesktopRenderHostAssignment, "jobId" | "leaseId">,
): "pause" | "cancel" | undefined {
  if (incoming.jobId !== assignment.jobId || incoming.leaseId !== assignment.leaseId)
    return current;
  return incoming.command === "cancel" ? "cancel" : (current ?? "pause");
}

function assertManifestComposition(manifest: RenderJobManifest, composition: Composition): void {
  if (composition.width !== manifest.width || composition.height !== manifest.height)
    throw new Error("RenderHost dimensions do not match the immutable composition");
  if (
    composition.frameRate.numerator !== manifest.frameRate.numerator ||
    composition.frameRate.denominator !== manifest.frameRate.denominator
  )
    throw new Error("RenderHost frame rate does not match the immutable composition");
  const availableFrames = Math.ceil(
    (composition.duration * composition.frameRate.numerator) / composition.frameRate.denominator,
  );
  if (manifest.endFrameExclusive > availableFrames)
    throw new Error("RenderHost frame range exceeds the immutable composition");
}

function compositionUsesVideo(project: Project, root: Composition): boolean {
  const visited = new Set<string>();
  const visit = (composition: Composition): boolean => {
    if (visited.has(composition.id)) return false;
    visited.add(composition.id);
    return composition.layers.some((layer) => {
      if (layer.kind === "video") return true;
      if (
        layer.sourceId &&
        project.sources.some((source) => source.id === layer.sourceId && source.kind === "video")
      )
        return true;
      if (!layer.sourceCompositionId) return false;
      const nested = project.compositions.find(
        (candidate) => candidate.id === layer.sourceCompositionId,
      );
      return nested ? visit(nested) : false;
    });
  };
  return visit(root);
}

function validateRawFrame(
  frame: RawVideoFrame,
  manifest: RenderJobManifest,
  pixelFormat: Mp4PixelFormat,
): void {
  if (frame.pixelFormat !== pixelFormat)
    throw new Error("RenderHost renderer changed pixel format during the session");
  if (frame.pixels.byteLength !== manifest.width * manifest.height * 4)
    throw new Error("RenderHost beauty frame has an invalid byte length");
}

async function reportControlBoundary(
  report: RenderHostFrameLoopOptions["report"],
  shared: { jobId: string; leaseId: string },
  control: "pause" | "cancel",
): Promise<"paused" | "cancelled"> {
  const result = control === "pause" ? "paused" : "cancelled";
  await report({ type: result, ...shared });
  return result;
}

async function prepareAudioPipeline(
  options: RenderHostFrameLoopOptions,
  requested: boolean,
): Promise<
  | {
      project: Project;
      composition: Composition;
      decoded: Awaited<ReturnType<typeof decodeAudibleSources>>;
      frameCount: number;
    }
  | undefined
> {
  if (!requested) return undefined;
  if (!options.audioDecoder)
    throw new Error("RenderHost audio output requires the immutable project snapshot decoder");
  const decoded = await decodeAudibleSources(
    options.assignment.project,
    options.assignment.composition,
    options.audioDecoder,
  );
  // Match the foreground exporter: requesting audio with no audible footage produces video-only
  // MP4 instead of manufacturing a silent track.
  if (decoded.size === 0) return undefined;
  const { manifest } = options.assignment;
  return {
    project: options.assignment.project,
    composition: options.assignment.composition,
    decoded,
    frameCount: alignedAudioFrameCount(
      manifest.endFrameExclusive - manifest.startFrame,
      manifest.frameRate,
      EXPORT_AUDIO_SAMPLE_RATE,
    ),
  };
}

function throwAudioFailure(failure: { reason: unknown } | undefined): void {
  if (failure) throw failure.reason;
}

async function stopAtControlBoundary(
  report: RenderHostFrameLoopOptions["report"],
  shared: { jobId: string; leaseId: string },
  control: "pause" | "cancel",
  abortAudio: () => void,
  audioPipeline: Promise<number>,
): Promise<"paused" | "cancelled"> {
  abortAudio();
  // A terminal report lets Electron dispose the encoder and staged outputs immediately. Drain any
  // PCM write already accepted by IPC before publishing that boundary so it cannot write into a
  // disposed worker after pause/cancel acknowledgement.
  await audioPipeline;
  return await reportControlBoundary(report, shared, control);
}
