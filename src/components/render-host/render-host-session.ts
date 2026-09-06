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
  /** Captures the current control signal before re-reading requestedControl to avoid lost wakeups. */
  waitForControlChange?(): Promise<void>;
  now?(): number;
}

export type RenderHostFrameLoopResult = "completed" | "cancelled";

/** Narrows an assignment to the only fields accepted by terminal report IPC. */
export function renderHostCorrelation(
  assignment: Pick<DesktopRenderHostAssignment, "jobId" | "leaseId">,
): Pick<DesktopRenderHostAssignment, "jobId" | "leaseId"> {
  return { jobId: assignment.jobId, leaseId: assignment.leaseId };
}

/** Evaluates beauty frames sequentially while bounded audio writes run with independent backpressure. */
export async function runRenderHostFrameLoop(
  options: RenderHostFrameLoopOptions,
): Promise<RenderHostFrameLoopResult> {
  const validated = options.assignment;
  const { assignment, manifest } = validated;
  const shared = { jobId: assignment.jobId, leaseId: assignment.leaseId };
  const initialControl = options.requestedControl();
  if (initialControl === "cancel") return await reportCancelled(options.report, shared);
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
      videoBitrateBps: Math.round(output.bitrateMbps * 1_000_000),
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
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let pausedDurationMs = 0;
  let audioAborted = false;
  let audioFailure: { reason: unknown } | undefined;
  const audioPipeline = audio
    ? streamCompositionAudio(
        audio.project,
        audio.composition,
        audio.decoded,
        audio.frameCount,
        async (samples) => {
          const control = await waitForPauseRelease(options);
          if (control === "cancel") {
            audioAborted = true;
            return;
          }
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
        () => audioAborted || options.requestedControl() === "cancel",
        EXPORT_AUDIO_SAMPLE_RATE,
        frameTimeAtIndex(manifest.startFrame, manifest.frameRate),
      ).catch((error: unknown) => {
        audioFailure = { reason: error };
        audioAborted = true;
        return -1;
      })
    : Promise.resolve(0);
  const totalFrames = manifest.endFrameExclusive - manifest.startFrame;
  const waitAtControlBoundary = async (): Promise<"continue" | "cancel"> => {
    const control = options.requestedControl();
    if (control === "cancel") return "cancel";
    if (control !== "pause") return "continue";
    const pausedAt = now();
    await options.report({ type: "paused", ...shared });
    const released = await waitForPauseRelease(options);
    pausedDurationMs += Math.max(0, now() - pausedAt);
    return released;
  };
  try {
    for (let frame = manifest.startFrame; frame < manifest.endFrameExclusive; frame += 1) {
      throwAudioFailure(audioFailure);
      if ((await waitAtControlBoundary()) === "cancel") {
        audioAborted = true;
        await audioPipeline;
        return await reportCancelled(options.report, shared);
      }
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
      const elapsedMs = Math.max(0, now() - startedAt - pausedDurationMs);
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

    if ((await waitAtControlBoundary()) === "cancel") {
      audioAborted = true;
      await audioPipeline;
      return await reportCancelled(options.report, shared);
    }
    const completedAudioFrames = await waitForAudioWithControls(
      options,
      audioPipeline,
      waitAtControlBoundary,
      () => {
        audioAborted = true;
      },
    );
    if (completedAudioFrames === undefined) return await reportCancelled(options.report, shared);
    throwAudioFailure(audioFailure);
    if (audio && completedAudioFrames !== audio.frameCount)
      throw new Error(
        "RenderHost audio pipeline stopped before the rational frame range completed",
      );
    for (const output of mp4Outputs)
      await options.output({ type: "finishMp4", ...shared, outputId: output.id });
    if ((await waitAtControlBoundary()) === "cancel")
      return await reportCancelled(options.report, shared);
    await options.report({ type: "completed", ...shared });
    return "completed";
  } catch (error) {
    audioAborted = true;
    // Propagate failure so the host can close the encoder and release blocked PCM writes.
    // The audio pipeline captures its own rejection, including errors from that cleanup.
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
  if (incoming.command === "cancel") return "cancel";
  if (current === "cancel") return current;
  if (incoming.command === "resume") return undefined;
  return current ?? "pause";
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

async function reportCancelled(
  report: RenderHostFrameLoopOptions["report"],
  shared: { jobId: string; leaseId: string },
): Promise<"cancelled"> {
  await report({ type: "cancelled", ...shared });
  return "cancelled";
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

async function waitForPauseRelease(
  options: RenderHostFrameLoopOptions,
): Promise<"continue" | "cancel"> {
  while (true) {
    // Capture the signal first. A control delivered between this capture and the state read resolves
    // this exact promise; a control delivered earlier is visible in requestedControl immediately.
    const changed = options.waitForControlChange?.();
    const control = options.requestedControl();
    if (control === "cancel") return "cancel";
    if (control !== "pause") return "continue";
    if (!changed) throw new Error("RenderHost pause requires a resumable control signal");
    await changed;
  }
}

async function waitForAudioWithControls(
  options: RenderHostFrameLoopOptions,
  audioPipeline: Promise<number>,
  waitAtControlBoundary: () => Promise<"continue" | "cancel">,
  abortAudio: () => void,
): Promise<number | undefined> {
  const completed = audioPipeline.then((value) => ({ type: "completed" as const, value }));
  while (true) {
    if ((await waitAtControlBoundary()) === "cancel") {
      abortAudio();
      // Drain an accepted PCM write before Electron is allowed to dispose its encoder.
      await audioPipeline;
      return undefined;
    }
    const changed = options.waitForControlChange?.();
    if (!changed) return await audioPipeline;
    if (options.requestedControl() !== undefined) continue;
    const result = await Promise.race([
      completed,
      changed.then(() => ({ type: "control" as const })),
    ]);
    if (result.type === "completed") return result.value;
  }
}
