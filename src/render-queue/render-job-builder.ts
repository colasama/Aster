import { runCpuTask } from "../core/cpu-scheduler";
import { projectDocumentForPersistence, serializeProject } from "../core/project-file";
import {
  type EnqueueRenderJobInput,
  MAX_RENDER_SNAPSHOT_BYTES,
  type RenderOutputModule,
} from "../core/render-queue";
import { type Composition, createId, type Project } from "../core/types";
import {
  captureRenderMediaManifest,
  serializeRenderMediaManifest,
  serializeRenderMediaManifestSync,
} from "./render-media-manifest";

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
  const composition = compositionFromProject(options.project, options.composition.id);
  const renderMediaSnapshot = serializeRenderMediaManifestSync(
    captureRenderMediaManifest(options.project, composition.id),
  );
  return createJobWithSnapshot(
    { ...options, composition },
    serializeProject(options.project),
    renderMediaSnapshot,
  );
}

export async function createRenderQueueJobAsync(
  options: RenderQueueJobOptions,
): Promise<EnqueueRenderJobInput> {
  // Capture the document and composition descriptor before yielding to the CPU worker. Queue
  // manifests must describe the exact serialized snapshot even if the editor advances meanwhile.
  const runtimeComposition = compositionFromProject(options.project, options.composition.id);
  const mediaCapture = captureRenderMediaManifest(options.project, runtimeComposition.id);
  const project = projectDocumentForPersistence(options.project);
  const composition = compositionFromProject(project, options.composition.id);
  const [projectSnapshot, renderMediaSnapshot] = await Promise.all([
    runCpuTask(
      {
        kind: "serialize-json",
        maxOutputCharacters: MAX_RENDER_SNAPSHOT_BYTES / 2,
        spacing: 2,
        trailingNewline: true,
        value: project,
      },
      { priority: "interactive", timeoutMs: 120_000 },
    ),
    serializeRenderMediaManifest(mediaCapture),
  ]);
  return createJobWithSnapshot(
    { ...options, project, composition },
    projectSnapshot,
    renderMediaSnapshot,
  );
}

function createJobWithSnapshot(
  options: RenderQueueJobOptions,
  projectSnapshot: string,
  renderMediaSnapshot: string,
): EnqueueRenderJobInput {
  if (projectSnapshot.length + renderMediaSnapshot.length > MAX_RENDER_SNAPSHOT_BYTES / 2)
    throw new Error("Render project and media snapshots exceed the supported job limit");
  const composition = compositionFromProject(options.project, options.composition.id);
  const frameRange = resolveFrameRange(composition, options.range, options.currentTime);
  if (options.outputKind === "mp4" && (composition.width % 2 !== 0 || composition.height % 2 !== 0))
    throw new Error("H.264 output dimensions must be even");
  return {
    compositionId: composition.id,
    compositionName: composition.name,
    projectRevision: options.projectRevision,
    projectSnapshot,
    renderMediaSnapshot,
    width: composition.width,
    height: composition.height,
    frameRate: { ...composition.frameRate },
    startFrame: frameRange.start,
    endFrameExclusive: frameRange.end,
    outputs: [createOutput(options.outputKind, options.destination, frameRange.start)],
  };
}

function compositionFromProject(project: Project, compositionId: string): Composition {
  const composition = project.compositions.find((candidate) => candidate.id === compositionId);
  if (!composition)
    throw new Error("Render queue composition is not present in the captured project snapshot");
  return composition;
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
