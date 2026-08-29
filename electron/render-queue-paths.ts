import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RenderQueueState } from "../src/core/render-queue.js";

export function renderPathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

/** Allows an exact picker result or one direct child of a picker-selected existing directory. */
export function isRenderDestinationAuthorized(
  destination: string,
  grantedPathKeys: ReadonlySet<string>,
): boolean {
  const normalized = renderPathKey(destination);
  if (grantedPathKeys.has(normalized)) return true;
  const parent = renderPathKey(dirname(destination));
  if (!grantedPathKeys.has(parent)) return false;
  try {
    return statSync(parent).isDirectory();
  } catch {
    return false;
  }
}

export function ownedRenderOutputPath(queue: RenderQueueState, value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096)
    throw new Error("Render output path is invalid");
  const normalized = renderPathKey(value);
  const output = queue.items
    .flatMap((item) => item.manifest.outputs)
    .find((candidate) => renderPathKey(candidate.destination) === normalized);
  if (!output) throw new Error("Render output path is not owned by the queue");
  return resolve(output.destination);
}
