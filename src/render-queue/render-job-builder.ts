import { projectDocumentForPersistence, serializeProject } from "../core/project/project-file";
import {
  type EnqueueRenderJobInput,
  MAX_RENDER_SNAPSHOT_BYTES,
  type RenderOutputModule,
} from "../core/rendering/render-queue";
import { runCpuTask } from "../core/scheduling/cpu-scheduler";
import { type Composition, createId, type Project } from "../core/types";
import {
  captureRenderMediaManifest,
  serializeRenderMediaManifest,
  serializeRenderMediaManifestSync,
} from "./render-media-manifest";

export type RenderQueueOutputKind = "mp4" | "pngSequence" | "still";
export type RenderQueueRange = "workArea" | "composition" | "currentFrame" | "custom";

export const DEFAULT_MP4_BITRATE_MBPS = 20;
export const DEFAULT_SEQUENCE_PATTERN = "frame_[######].png";

export type RenderQueueOutputOptions =
  | { readonly kind: "mp4"; readonly bitrateMbps: number; readonly includeAudio: boolean }
  | { readonly kind: "pngSequence"; readonly fileNamePattern: string }
  | { readonly kind: "still"; readonly format: "png" };

export interface RenderQueueCustomRange {
  /** Seconds. */
  readonly start: number;
  /** Seconds; exclusive, clamped to the composition duration. */
  readonly end: number;
}

export function defaultRenderOutputOptions(
  kind: "mp4",
): Extract<RenderQueueOutputOptions, { kind: "mp4" }>;
export function defaultRenderOutputOptions(kind: RenderQueueOutputKind): RenderQueueOutputOptions;
export function defaultRenderOutputOptions(kind: RenderQueueOutputKind): RenderQueueOutputOptions {
  if (kind === "mp4") return { kind, bitrateMbps: DEFAULT_MP4_BITRATE_MBPS, includeAudio: false };
  if (kind === "pngSequence") return { kind, fileNamePattern: DEFAULT_SEQUENCE_PATTERN };
  return { kind, format: "png" };
}

export function isValidSequencePattern(pattern: string): boolean {
  const lowered = pattern.trim().toLowerCase();
  return (
    lowered.length > 4 &&
    lowered.endsWith(".png") &&
    !/[\\/]/.test(pattern) &&
    (pattern.match(/\[(#+)\]/g) ?? []).length <= 1
  );
}

export interface RenderQueueJobOptions {
  readonly antiAliasing?: import("../core/rendering/anti-aliasing").AntiAliasingMode;
  readonly composition: Composition;
  readonly project: Project;
  readonly projectRevision: number;
  readonly output: RenderQueueOutputOptions;
  readonly destination: string;
  readonly range: RenderQueueRange;
  readonly customRange?: RenderQueueCustomRange;
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
  const frameRange = resolveFrameRange(
    composition,
    options.range,
    options.currentTime,
    options.customRange,
  );
  if (
    options.output.kind === "mp4" &&
    (composition.width % 2 !== 0 || composition.height % 2 !== 0)
  )
    throw new Error("H.264 output dimensions must be even");
  if (
    options.output.kind === "pngSequence" &&
    !isValidSequencePattern(options.output.fileNamePattern)
  )
    throw new Error("PNG sequence file name must be a plain .png file name");
  return {
    compositionId: composition.id,
    compositionName: composition.name,
    antiAliasing: options.antiAliasing ?? "off",
    projectRevision: options.projectRevision,
    projectSnapshot,
    renderMediaSnapshot,
    width: composition.width,
    height: composition.height,
    frameRate: { ...composition.frameRate },
    startFrame: frameRange.start,
    endFrameExclusive: frameRange.end,
    outputs: [createOutput(options.output, options.destination, frameRange.start)],
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
  customRange?: RenderQueueCustomRange,
): { start: number; end: number } {
  const rate = composition.frameRate.numerator / composition.frameRate.denominator;
  const total = Math.max(1, Math.ceil(composition.duration * rate - 1e-9));
  if (range === "custom") {
    const start = Math.max(0, Math.min(total - 1, Math.round((customRange?.start ?? 0) * rate)));
    const end = Math.max(
      start + 1,
      Math.min(total, Math.round((customRange?.end ?? composition.duration) * rate)),
    );
    return { start, end };
  }
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
  output: RenderQueueOutputOptions,
  destination: string,
  startFrame: number,
): RenderOutputModule {
  const id = createId();
  if (output.kind === "mp4")
    return {
      id,
      kind: "mp4",
      destination,
      codec: "h264",
      bitrateMbps: Math.min(Math.max(output.bitrateMbps, 0.1), 1_000),
      includeAudio: output.includeAudio,
    };
  if (output.kind === "pngSequence")
    return { id, kind: "pngSequence", destination, fileNamePattern: output.fileNamePattern };
  return { id, kind: "still", destination, format: output.format, frame: startFrame };
}
