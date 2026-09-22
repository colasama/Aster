import type { Project } from "../core/types";
import type { NormalizedCommandBatch } from "./command-normalizer";
import { EDIT_LIMITS, EditError } from "./edit-limits";

export interface EditTask {
  project: Project;
  currentTime: number;
  maxOperations: number;
  code?: string;
  commands?: unknown[];
}
export interface EditTaskResult extends NormalizedCommandBatch {
  result: unknown;
}
export interface EditProgress {
  fraction: number;
  message: string;
  operations: number;
}
export type EditTaskRunner = (
  task: EditTask,
  signal: AbortSignal,
  progress: (value: EditProgress) => void,
) => Promise<EditTaskResult>;

/** One disposable worker per execution makes cancellation independent of guest cooperation. */
export const runEditTask: EditTaskRunner = (task, signal, progress) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new EditError("cancelled", "Execution cancelled"));
      return;
    }
    const worker = new Worker(new URL("./edit-worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.terminate();
    };
    const cancel = () => {
      finish();
      reject(new EditError("cancelled", "Execution cancelled"));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new EditError("execution_timeout", "Execution exceeded 30 seconds"));
    }, EDIT_LIMITS.executionMs);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = (event) => {
      finish();
      reject(new EditError("worker_failed", event.message || "Editing worker failed"));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        progress(data.value);
        return;
      }
      finish();
      if (data.type === "result") resolve(data.value as EditTaskResult);
      else reject(new EditError(data.error.code, data.error.message, data.error.details));
    };
    try {
      worker.postMessage(task);
    } catch (error) {
      finish();
      reject(error);
    }
  });
