type Id = string;

export const CURRENT_RENDER_QUEUE_VERSION = 1 as const;
export const MAX_RENDER_QUEUE_ITEMS = 256;
export const MAX_RENDER_OUTPUTS = 8;
export const MAX_RENDER_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_RENDER_FRAMES = 10_000_000;

export type RenderJobStatus =
  | "queued"
  | "preparing"
  | "rendering"
  | "pauseRequested"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type RenderOutputModule =
  | {
      id: Id;
      kind: "mp4";
      destination: string;
      codec: "h264" | "h265";
      bitrateMbps: number;
      includeAudio: boolean;
    }
  | {
      id: Id;
      kind: "pngSequence";
      destination: string;
      fileNamePattern: string;
    }
  | {
      id: Id;
      kind: "still";
      destination: string;
      format: "png" | "exr";
      frame: number;
    };

export interface RenderJobManifest {
  id: Id;
  compositionId: Id;
  compositionName: string;
  projectRevision: number;
  /** Immutable serialized project document captured when the item is queued. */
  projectSnapshot: string;
  /** Versioned runtime media registry/locator capture hydrated by an isolated RenderHost. */
  renderMediaSnapshot?: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  startFrame: number;
  endFrameExclusive: number;
  outputs: RenderOutputModule[];
  priority: number;
  createdAt: string;
}

export interface RenderJobProgress {
  completedFrames: number;
  totalFrames: number;
  elapsedMs: number;
  estimatedRemainingMs?: number;
}

export interface RenderQueueItem {
  manifest: RenderJobManifest;
  status: RenderJobStatus;
  attempts: number;
  progress: RenderJobProgress;
  workerLeaseId?: Id;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string; correlationId?: Id };
}

export interface RenderQueueState {
  schemaVersion: typeof CURRENT_RENDER_QUEUE_VERSION;
  revision: number;
  items: RenderQueueItem[];
}

export type RenderQueueViewManifest = Omit<
  RenderJobManifest,
  "projectSnapshot" | "renderMediaSnapshot"
>;

export interface RenderQueueViewItem extends Omit<RenderQueueItem, "manifest" | "workerLeaseId"> {
  manifest: RenderQueueViewManifest;
}

/** Lightweight renderer projection: immutable project captures never cross progress IPC. */
export interface RenderQueueViewState extends Omit<RenderQueueState, "items"> {
  items: RenderQueueViewItem[];
}

export interface EnqueueRenderJobInput
  extends Omit<RenderJobManifest, "id" | "createdAt" | "priority"> {
  id?: Id;
  createdAt?: string;
  priority?: number;
}

export function createRenderQueue(): RenderQueueState {
  return { schemaVersion: CURRENT_RENDER_QUEUE_VERSION, revision: 0, items: [] };
}

export function renderQueueView(state: RenderQueueState): RenderQueueViewState {
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    items: state.items.map((item) => {
      const { workerLeaseId: _workerLeaseId, manifest: sourceManifest, ...summary } = item;
      const {
        projectSnapshot: _projectSnapshot,
        renderMediaSnapshot: _renderMediaSnapshot,
        ...manifest
      } = sourceManifest;
      return {
        ...summary,
        manifest: {
          ...manifest,
          frameRate: { ...manifest.frameRate },
          outputs: manifest.outputs.map((output) => ({ ...output })),
        },
        progress: { ...item.progress },
        ...(item.error ? { error: { ...item.error } } : {}),
      };
    }),
  };
}

export function enqueueRenderJob(
  state: RenderQueueState,
  input: EnqueueRenderJobInput,
  createId: () => Id = defaultId,
): RenderQueueState {
  if (state.items.length >= MAX_RENDER_QUEUE_ITEMS) throw new Error("Render queue is full");
  const manifest = normalizeManifest(
    {
      ...input,
      id: input.id ?? createId(),
      priority: input.priority ?? nextPriority(state),
      createdAt: input.createdAt ?? new Date().toISOString(),
    },
    "render job",
  );
  if (state.items.some((item) => item.manifest.id === manifest.id))
    throw new Error(`Render queue already contains ${manifest.id}`);
  return revise(state, [
    ...state.items,
    {
      manifest,
      status: "queued",
      attempts: 0,
      progress: emptyProgress(manifest),
    },
  ]);
}

export function claimRenderJob(
  state: RenderQueueState,
  jobId: Id,
  workerLeaseId: Id,
  now = new Date(),
): RenderQueueState {
  return updateItem(state, jobId, (item) => {
    if (item.status !== "queued") throw invalidTransition(item, "preparing");
    return {
      ...item,
      status: "preparing",
      attempts: item.attempts + 1,
      workerLeaseId: boundedId(workerLeaseId, "worker lease"),
      startedAt: now.toISOString(),
      finishedAt: undefined,
      error: undefined,
      progress: emptyProgress(item.manifest),
    };
  });
}

export function markRenderJobRunning(
  state: RenderQueueState,
  jobId: Id,
  workerLeaseId: Id,
): RenderQueueState {
  return leasedUpdate(state, jobId, workerLeaseId, (item) => {
    if (item.status !== "preparing") throw invalidTransition(item, "rendering");
    return { ...item, status: "rendering" };
  });
}

export function updateRenderProgress(
  state: RenderQueueState,
  jobId: Id,
  workerLeaseId: Id,
  progress: RenderJobProgress,
): RenderQueueState {
  return leasedUpdate(state, jobId, workerLeaseId, (item) => {
    if (item.status !== "rendering" && item.status !== "pauseRequested")
      throw invalidTransition(item, "rendering progress");
    const normalized = normalizeProgress(progress, item.progress.totalFrames);
    if (normalized.completedFrames < item.progress.completedFrames)
      throw new Error("Render progress cannot move backwards");
    if (
      normalized.completedFrames === item.progress.completedFrames &&
      normalized.elapsedMs === item.progress.elapsedMs &&
      normalized.estimatedRemainingMs === item.progress.estimatedRemainingMs
    )
      return item;
    return { ...item, progress: normalized };
  });
}

export function requestRenderPause(state: RenderQueueState, jobId: Id): RenderQueueState {
  return updateItem(state, jobId, (item) => {
    if (item.status === "queued") return { ...item, status: "paused" };
    if (item.status !== "rendering") throw invalidTransition(item, "pauseRequested");
    return { ...item, status: "pauseRequested" };
  });
}

export function acknowledgeRenderPaused(
  state: RenderQueueState,
  jobId: Id,
  workerLeaseId: Id,
): RenderQueueState {
  return leasedUpdate(state, jobId, workerLeaseId, (item) => {
    if (item.status !== "pauseRequested") throw invalidTransition(item, "paused");
    return { ...item, status: "paused", workerLeaseId: undefined };
  });
}

export function resumeRenderJob(state: RenderQueueState, jobId: Id): RenderQueueState {
  return updateItem(state, jobId, (item) => {
    if (item.status !== "paused") throw invalidTransition(item, "queued");
    return { ...item, status: "queued", workerLeaseId: undefined };
  });
}

export function completeRenderJob(
  state: RenderQueueState,
  jobId: Id,
  workerLeaseId: Id,
  now = new Date(),
): RenderQueueState {
  return leasedUpdate(state, jobId, workerLeaseId, (item) => {
    if (item.status !== "rendering") throw invalidTransition(item, "completed");
    return {
      ...item,
      status: "completed",
      workerLeaseId: undefined,
      finishedAt: now.toISOString(),
      progress: {
        ...item.progress,
        completedFrames: item.progress.totalFrames,
        estimatedRemainingMs: 0,
      },
    };
  });
}

export function failRenderJob(
  state: RenderQueueState,
  jobId: Id,
  workerLeaseId: Id,
  error: RenderQueueItem["error"],
  now = new Date(),
): RenderQueueState {
  return leasedUpdate(state, jobId, workerLeaseId, (item) => {
    if (!RUNNING_STATUSES.has(item.status)) throw invalidTransition(item, "failed");
    return {
      ...item,
      status: "failed",
      workerLeaseId: undefined,
      finishedAt: now.toISOString(),
      error: normalizeRenderError(error),
    };
  });
}

export function cancelRenderJob(
  state: RenderQueueState,
  jobId: Id,
  now = new Date(),
): RenderQueueState {
  return updateItem(state, jobId, (item) => {
    if (TERMINAL_STATUSES.has(item.status)) return item;
    return {
      ...item,
      status: "cancelled",
      workerLeaseId: undefined,
      finishedAt: now.toISOString(),
    };
  });
}

export function retryRenderJob(state: RenderQueueState, jobId: Id): RenderQueueState {
  return updateItem(state, jobId, (item) => {
    if (item.status !== "failed" && item.status !== "cancelled")
      throw invalidTransition(item, "queued");
    return {
      ...item,
      status: "queued",
      workerLeaseId: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      progress: emptyProgress(item.manifest),
    };
  });
}

/**
 * Removes a job only after it no longer owns a render-host lease. Active jobs must be cancelled
 * first so their worker can acknowledge the frame boundary and dispose staged output safely.
 */
export function removeRenderJob(state: RenderQueueState, jobId: Id): RenderQueueState {
  const index = state.items.findIndex((item) => item.manifest.id === jobId);
  if (index < 0) throw new Error(`Unknown render job ${jobId}`);
  const item = state.items[index] as RenderQueueItem;
  if (RUNNING_STATUSES.has(item.status) || item.workerLeaseId)
    throw invalidTransition(item, "removed");
  return revise(
    state,
    state.items.filter((candidate) => candidate.manifest.id !== jobId),
  );
}

export function reprioritizeRenderJob(
  state: RenderQueueState,
  jobId: Id,
  priority: number,
): RenderQueueState {
  return updateItem(state, jobId, (item) => {
    const normalized = boundedInteger(priority, -1_000_000, 1_000_000, "render priority");
    return item.manifest.priority === normalized
      ? item
      : { ...item, manifest: { ...item.manifest, priority: normalized } };
  });
}

export function nextRunnableRenderJobs(
  state: RenderQueueState,
  maximum: number,
): readonly RenderQueueItem[] {
  const active = state.items.filter((item) => RUNNING_STATUSES.has(item.status)).length;
  const available = Math.max(0, boundedInteger(maximum, 1, 8, "render concurrency") - active);
  return state.items
    .filter((item) => item.status === "queued")
    .sort(
      (left, right) =>
        right.manifest.priority - left.manifest.priority ||
        left.manifest.createdAt.localeCompare(right.manifest.createdAt) ||
        left.manifest.id.localeCompare(right.manifest.id),
    )
    .slice(0, available);
}

/**
 * Invalidates leases left behind by a terminated render host. Partial outputs are never resumed in
 * place: workers publish atomically, so an interrupted item must be explicitly retried from frame
 * zero before it can replace its destination.
 */
export function recoverInterruptedRenderJobs(
  state: RenderQueueState,
  now = new Date(),
): RenderQueueState {
  let changed = false;
  const finishedAt = now.toISOString();
  const items = state.items.map((item) => {
    if (!RUNNING_STATUSES.has(item.status)) return item;
    changed = true;
    return {
      ...item,
      status: "failed" as const,
      workerLeaseId: undefined,
      finishedAt,
      error: {
        code: "render_host_interrupted",
        message: "The render host stopped before publishing its outputs. Retry to render again.",
      },
    };
  });
  return changed ? revise(state, items) : state;
}

export function serializeRenderQueue(state: RenderQueueState): string {
  return `${JSON.stringify(normalizeRenderQueue(state), null, 2)}\n`;
}

export function migrateRenderQueue(value: unknown): RenderQueueState {
  if (!isRecord(value)) return createRenderQueue();
  const version = value.schemaVersion ?? 0;
  if (!Number.isSafeInteger(version) || Number(version) < 0)
    throw new Error("Render queue schema version is invalid");
  if (Number(version) > CURRENT_RENDER_QUEUE_VERSION)
    throw new Error(`Render queue v${String(version)} is newer than this build`);
  const document =
    version === 0
      ? { ...value, schemaVersion: 1, revision: value.revision ?? 0, items: value.items ?? [] }
      : value;
  return normalizeRenderQueue(document);
}

function normalizeRenderQueue(value: unknown): RenderQueueState {
  if (!isRecord(value) || value.schemaVersion !== CURRENT_RENDER_QUEUE_VERSION)
    throw new Error("Render queue document is invalid");
  const revision = boundedInteger(value.revision, 0, Number.MAX_SAFE_INTEGER, "queue revision");
  if (!Array.isArray(value.items) || value.items.length > MAX_RENDER_QUEUE_ITEMS)
    throw new Error("Render queue item count is invalid");
  const ids = new Set<string>();
  const items = value.items.map((entry, index) => normalizeItem(entry, `items[${index}]`));
  for (const item of items) {
    if (ids.has(item.manifest.id)) throw new Error(`Duplicate render job ${item.manifest.id}`);
    ids.add(item.manifest.id);
  }
  return { schemaVersion: CURRENT_RENDER_QUEUE_VERSION, revision, items };
}

function normalizeItem(value: unknown, path: string): RenderQueueItem {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const manifest = normalizeManifest(value.manifest, `${path}.manifest`);
  if (!isRenderStatus(value.status)) throw new Error(`${path}.status is invalid`);
  const status = value.status;
  const attempts = boundedInteger(value.attempts, 0, 1_000, `${path}.attempts`);
  const progress = normalizeProgress(value.progress, frameCount(manifest));
  const workerLeaseId = optionalId(value.workerLeaseId, `${path}.workerLeaseId`);
  if (RUNNING_STATUSES.has(status) && !workerLeaseId)
    throw new Error(`${path} requires a worker lease while active`);
  if (!RUNNING_STATUSES.has(status) && workerLeaseId)
    throw new Error(`${path} cannot retain an inactive worker lease`);
  return {
    manifest,
    status,
    attempts,
    progress,
    ...(workerLeaseId ? { workerLeaseId } : {}),
    ...(optionalTimestamp(value.startedAt)
      ? { startedAt: optionalTimestamp(value.startedAt) }
      : {}),
    ...(optionalTimestamp(value.finishedAt)
      ? { finishedAt: optionalTimestamp(value.finishedAt) }
      : {}),
    ...(value.error === undefined ? {} : { error: normalizeRenderError(value.error) }),
  };
}

function normalizeManifest(value: unknown, path: string): RenderJobManifest {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const id = boundedId(value.id, `${path}.id`);
  const compositionId = boundedId(value.compositionId, `${path}.compositionId`);
  const compositionName = boundedString(value.compositionName, 512, `${path}.compositionName`);
  const projectRevision = boundedInteger(
    value.projectRevision,
    0,
    Number.MAX_SAFE_INTEGER,
    `${path}.projectRevision`,
  );
  const projectSnapshot = boundedString(
    value.projectSnapshot,
    MAX_RENDER_SNAPSHOT_BYTES / 2,
    `${path}.projectSnapshot`,
  );
  try {
    JSON.parse(projectSnapshot);
  } catch {
    throw new Error(`${path}.projectSnapshot must be valid JSON`);
  }
  const renderMediaSnapshot = boundedString(
    value.renderMediaSnapshot ?? '{"version":1,"entries":[],"payloads":[]}',
    MAX_RENDER_SNAPSHOT_BYTES / 2,
    `${path}.renderMediaSnapshot`,
  );
  if (projectSnapshot.length + renderMediaSnapshot.length > MAX_RENDER_SNAPSHOT_BYTES / 2)
    throw new Error(`${path} snapshot payload exceeds the supported limit`);
  try {
    JSON.parse(renderMediaSnapshot);
  } catch {
    throw new Error(`${path}.renderMediaSnapshot must be valid JSON`);
  }
  const width = boundedInteger(value.width, 1, 32_768, `${path}.width`);
  const height = boundedInteger(value.height, 1, 32_768, `${path}.height`);
  if (!isRecord(value.frameRate)) throw new Error(`${path}.frameRate is invalid`);
  const frameRate = {
    numerator: boundedInteger(
      value.frameRate.numerator,
      1,
      1_000_000,
      `${path}.frameRate.numerator`,
    ),
    denominator: boundedInteger(
      value.frameRate.denominator,
      1,
      1_000_000,
      `${path}.frameRate.denominator`,
    ),
  };
  const startFrame = boundedInteger(value.startFrame, 0, MAX_RENDER_FRAMES, `${path}.startFrame`);
  const endFrameExclusive = boundedInteger(
    value.endFrameExclusive,
    1,
    MAX_RENDER_FRAMES,
    `${path}.endFrameExclusive`,
  );
  if (endFrameExclusive <= startFrame) throw new Error(`${path} has an empty frame range`);
  if (
    !Array.isArray(value.outputs) ||
    value.outputs.length < 1 ||
    value.outputs.length > MAX_RENDER_OUTPUTS
  )
    throw new Error(`${path}.outputs count is invalid`);
  const outputs = value.outputs.map((output, index) =>
    normalizeOutput(output, `${path}.outputs[${index}]`),
  );
  const outputIds = new Set(outputs.map((output) => output.id));
  if (outputIds.size !== outputs.length) throw new Error(`${path}.outputs contain duplicate ids`);
  return {
    id,
    compositionId,
    compositionName,
    projectRevision,
    projectSnapshot,
    renderMediaSnapshot,
    width,
    height,
    frameRate,
    startFrame,
    endFrameExclusive,
    outputs,
    priority: boundedInteger(value.priority, -1_000_000, 1_000_000, `${path}.priority`),
    createdAt: timestamp(value.createdAt, `${path}.createdAt`),
  };
}

function normalizeOutput(value: unknown, path: string): RenderOutputModule {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const shared = {
    id: boundedId(value.id, `${path}.id`),
    destination: boundedString(value.destination, 4_096, `${path}.destination`),
  };
  if (value.kind === "mp4") {
    if (value.codec !== "h264" && value.codec !== "h265")
      throw new Error(`${path}.codec is invalid`);
    return {
      ...shared,
      kind: "mp4",
      codec: value.codec,
      bitrateMbps: boundedNumber(value.bitrateMbps, 0.1, 1_000, `${path}.bitrateMbps`),
      includeAudio: value.includeAudio === true,
    };
  }
  if (value.kind === "pngSequence")
    return {
      ...shared,
      kind: "pngSequence",
      fileNamePattern: boundedString(value.fileNamePattern, 512, `${path}.fileNamePattern`),
    };
  if (value.kind === "still") {
    if (value.format !== "png" && value.format !== "exr")
      throw new Error(`${path}.format is invalid`);
    return {
      ...shared,
      kind: "still",
      format: value.format,
      frame: boundedInteger(value.frame, 0, MAX_RENDER_FRAMES, `${path}.frame`),
    };
  }
  throw new Error(`${path}.kind is invalid`);
}

function normalizeProgress(value: unknown, totalFrames: number): RenderJobProgress {
  if (!isRecord(value)) throw new Error("Render progress must be an object");
  const normalizedTotal = boundedInteger(value.totalFrames, 1, MAX_RENDER_FRAMES, "total frames");
  if (normalizedTotal !== totalFrames)
    throw new Error("Render progress total does not match manifest");
  const estimatedRemainingMs =
    value.estimatedRemainingMs === undefined
      ? undefined
      : boundedNumber(value.estimatedRemainingMs, 0, Number.MAX_SAFE_INTEGER, "remaining time");
  return {
    completedFrames: boundedInteger(value.completedFrames, 0, totalFrames, "completed frames"),
    totalFrames,
    elapsedMs: boundedNumber(value.elapsedMs, 0, Number.MAX_SAFE_INTEGER, "elapsed time"),
    ...(estimatedRemainingMs === undefined ? {} : { estimatedRemainingMs }),
  };
}

function normalizeRenderError(value: unknown): NonNullable<RenderQueueItem["error"]> {
  if (!isRecord(value)) throw new Error("Render error must be an object");
  return {
    code: boundedString(value.code, 96, "render error code"),
    message: boundedString(value.message, 2_048, "render error message"),
    ...(optionalId(value.correlationId, "render correlation id")
      ? { correlationId: optionalId(value.correlationId, "render correlation id") }
      : {}),
  };
}

function updateItem(
  state: RenderQueueState,
  jobId: Id,
  update: (item: RenderQueueItem) => RenderQueueItem,
): RenderQueueState {
  const index = state.items.findIndex((item) => item.manifest.id === jobId);
  if (index < 0) throw new Error(`Unknown render job ${jobId}`);
  const current = state.items[index] as RenderQueueItem;
  const next = update(current);
  if (next === current) return state;
  const items = state.items.slice();
  items[index] = next;
  return revise(state, items);
}

function leasedUpdate(
  state: RenderQueueState,
  jobId: Id,
  workerLeaseId: Id,
  update: (item: RenderQueueItem) => RenderQueueItem,
): RenderQueueState {
  return updateItem(state, jobId, (item) => {
    if (!item.workerLeaseId || item.workerLeaseId !== workerLeaseId)
      throw new Error(`Stale worker lease for render job ${jobId}`);
    return update(item);
  });
}

function revise(state: RenderQueueState, items: RenderQueueItem[]): RenderQueueState {
  return { ...state, revision: state.revision + 1, items };
}

function emptyProgress(manifest: RenderJobManifest): RenderJobProgress {
  return { completedFrames: 0, totalFrames: frameCount(manifest), elapsedMs: 0 };
}

function frameCount(manifest: RenderJobManifest): number {
  return manifest.endFrameExclusive - manifest.startFrame;
}

function nextPriority(state: RenderQueueState): number {
  return state.items.reduce((maximum, item) => Math.max(maximum, item.manifest.priority), -1) + 1;
}

function invalidTransition(item: RenderQueueItem, target: string): Error {
  return new Error(
    `Render job ${item.manifest.id} cannot transition from ${item.status} to ${target}`,
  );
}

function isRenderStatus(value: unknown): value is RenderJobStatus {
  return typeof value === "string" && ALL_STATUSES.has(value as RenderJobStatus);
}

function boundedId(value: unknown, name: string): Id {
  return boundedString(value, 128, name);
}

function optionalId(value: unknown, name: string): Id | undefined {
  return value === undefined ? undefined : boundedId(value, name);
}

function boundedString(value: unknown, maximum: number, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} is invalid`);
  return normalized;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new Error(`${name} is invalid`);
  return Number(value);
}

function boundedNumber(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${name} is invalid`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value)))
    throw new Error(`${name} is invalid`);
  return new Date(value).toISOString();
}

function optionalTimestamp(value: unknown): string | undefined {
  return value === undefined ? undefined : timestamp(value, "render timestamp");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultId(): Id {
  return crypto.randomUUID();
}

const RUNNING_STATUSES = new Set<RenderJobStatus>(["preparing", "rendering", "pauseRequested"]);
const TERMINAL_STATUSES = new Set<RenderJobStatus>(["completed", "failed", "cancelled"]);
const ALL_STATUSES = new Set<RenderJobStatus>([
  "queued",
  "preparing",
  "rendering",
  "pauseRequested",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
