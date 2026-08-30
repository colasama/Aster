import { randomUUID } from "node:crypto";
import type { RenderMediaSnapshotStore } from "./render-media-snapshot-store.js";

export interface IdentifiedRenderQueueInput {
  readonly jobId: string;
  readonly input: Record<string, unknown> & { readonly id: string };
}

/**
 * Assigns the durable job identity before any job-owned media is captured. The renderer enqueue
 * contract intentionally permits an omitted ID, while every snapshot and lifecycle command must
 * use the same normalized identity as the core queue manifest.
 */
export function identifyRenderQueueInput(
  value: unknown,
  createId: () => string = randomUUID,
): IdentifiedRenderQueueInput {
  if (!isRecord(value)) throw new Error("Render queue manifest is invalid");
  const jobId = boundedJobId(value.id === undefined ? createId() : value.id);
  return { jobId, input: { ...value, id: jobId } };
}

export async function captureAuthorizedRenderQueueInput(
  identified: IdentifiedRenderQueueInput,
  mediaSnapshots: Pick<RenderMediaSnapshotStore, "capture">,
  allowedAssets: Map<string, string>,
): Promise<IdentifiedRenderQueueInput> {
  const renderMediaSnapshot = await mediaSnapshots.capture(
    identified.jobId,
    typeof identified.input.renderMediaSnapshot === "string"
      ? identified.input.renderMediaSnapshot
      : '{"version":1,"entries":[],"payloads":[]}',
    { allowedAssets },
  );
  return {
    jobId: identified.jobId,
    input: { ...identified.input, renderMediaSnapshot },
  };
}

function boundedJobId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Render queue job ID is invalid");
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || normalized.includes("\0"))
    throw new Error("Render queue job ID is invalid");
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
