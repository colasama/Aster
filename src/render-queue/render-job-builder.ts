import { runCpuTask } from "../core/cpu-scheduler";
import { projectDocumentForPersistence, serializeProject } from "../core/project-file";
import {
  type EnqueueRenderJobInput,
  MAX_RENDER_SNAPSHOT_BYTES,
  type RenderOutputModule,
} from "../core/render-queue";
import { type Composition, createId, type Project } from "../core/types";

export type RenderQueueOutputKind = "mp4" | "pngSequence" | "still";
export type RenderQueueRange = "workArea" | "composition" | "currentFrame";

export interface RenderQueueJobOptions {
  readonly composition: Composition;
  readonly project: Project;
  readonly projectRevision: number;
  readonly outputKind: RenderQueueOutputKind;
  readonly destination: string;
  readonly range: RenderQueueRange;
  readonly currentTime: number;
}

export function createRenderQueueJob(options: RenderQueueJobOptions): EnqueueRenderJobInput {
  return createJobWithSnapshot(options, serializeProject(options.project));
}

export async function createRenderQueueJobAsync(
  options: RenderQueueJobOptions,
): Promise<EnqueueRenderJobInput> {
  const projectSnapshot = await runCpuTask(
    {
      kind: "serialize-json",
      maxOutputCharacters: MAX_RENDER_SNAPSHOT_BYTES / 2,
      spacing: 2,
      trailingNewline: true,
      value: projectDocumentForPersistence(options.project),
    },
    { priority: "interactive", timeoutMs: 120_000 },
  );
  return createJobWithSnapshot(options, projectSnapshot);
}

function createJobWithSnapshot(
  options: RenderQueueJobOptions,
  projectSnapshot: string,
): EnqueueRenderJobInput {
  const { composition } = options;
  const frameRange = resolveFrameRange(composition, options.range, options.currentTime);
  if (options.outputKind === "mp4" && (composition.width % 2 !== 0 || composition.height % 2 !== 0))
    throw new Error("H.264 output dimensions must be even");
  return {
    compositionId: composition.id,
    compositionName: composition.name,
    projectRevision: options.projectRevision,
    projectSnapshot,
    width: composition.width,
    height: composition.height,
    frameRate: { ...composition.frameRate },
    startFrame: frameRange.start,
    endFrameExclusive: frameRange.end,
    outputs: [createOutput(options.outputKind, options.destination, frameRange.start)],
  };
}

export function appendRenderSequenceName(parent: string, compositionName: string): string {
  const separator = parent.includes("\\") ? "\\" : "/";
  const root = parent.replace(/[\\/]+$/, "");
  const name = [...compositionName]
    .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
    .join("")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return `${root}${separator}${name || "render"}-frames`;
}

function resolveFrameRange(
  composition: Composition,
  range: RenderQueueRange,
  currentTime: number,
): { start: number; end: number } {
  const rate = composition.frameRate.numerator / composition.frameRate.denominator;
  const total = Math.max(1, Math.ceil(composition.duration * rate - 1e-9));
  if (range === "currentFrame") {
    const frame = Math.max(0, Math.min(total - 1, Math.floor(currentTime * rate + 1e-9)));
    return { start: frame, end: frame + 1 };
  }
  if (range === "composition") return { start: 0, end: total };
  const start = Math.max(0, Math.min(total - 1, Math.round(composition.workArea.start * rate)));
  const end = Math.max(start + 1, Math.min(total, Math.round(composition.workArea.end * rate)));
  return { start, end };
}

function createOutput(
  kind: RenderQueueOutputKind,
  destination: string,
  startFrame: number,
): RenderOutputModule {
  const id = createId();
  if (kind === "mp4")
    return {
      id,
      kind,
      destination,
      codec: "h264",
      bitrateMbps: 20,
      includeAudio: false,
    };
  if (kind === "pngSequence")
    return { id, kind, destination, fileNamePattern: "frame_[######].png" };
  return { id, kind, destination, format: "png", frame: startFrame };
}
