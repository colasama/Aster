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
  assignment: DesktopRenderHostAssignment;
  pixelFormat: Mp4PixelFormat;
  renderFrame(frame: number, time: number): Promise<RawVideoFrame>;
  encodePng(frame: RawVideoFrame): Promise<ArrayBuffer>;
  output(request: DesktopRenderHostOutputRequest): Promise<unknown>;
  report(report: DesktopRenderHostReport): Promise<void>;
  requestedControl(): "pause" | "cancel" | undefined;
  now?(): number;
}

export type RenderHostFrameLoopResult = "completed" | "paused" | "cancelled";

/** Executes one lease sequentially so pause and cancel are observed only at completed frame boundaries. */
export async function runRenderHostFrameLoop(
  options: RenderHostFrameLoopOptions,
): Promise<RenderHostFrameLoopResult> {
  const { assignment } = options;
  const { manifest } = assignment;
  const shared = { jobId: assignment.jobId, leaseId: assignment.leaseId };
  const mp4Outputs = manifest.outputs.filter((output) => output.kind === "mp4");
  const pngOutputs = manifest.outputs.filter(
    (output) => output.kind === "pngSequence" || output.kind === "still",
  );
  for (const output of mp4Outputs)
    await options.output({
      type: "startMp4",
      ...shared,
      outputId: output.id,
      pixelFormat: options.pixelFormat,
    });

  await options.report({ type: "prepared", ...shared });
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const totalFrames = manifest.endFrameExclusive - manifest.startFrame;
  for (let frame = manifest.startFrame; frame < manifest.endFrameExclusive; frame += 1) {
    const beforeFrame = options.requestedControl();
    if (beforeFrame) return await reportControlBoundary(options.report, shared, beforeFrame);
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
  if (afterLastFrame) return await reportControlBoundary(options.report, shared, afterLastFrame);
  for (const output of mp4Outputs)
    await options.output({ type: "finishMp4", ...shared, outputId: output.id });
  const afterEncoders = options.requestedControl();
  if (afterEncoders) return await reportControlBoundary(options.report, shared, afterEncoders);
  await options.report({ type: "completed", ...shared });
  return "completed";
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
