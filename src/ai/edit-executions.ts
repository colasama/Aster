import { createId } from "../core/types";
import { EditError, editErrorData } from "./edit-limits";
import type { EditProgress } from "./edit-task";

interface Execution {
  executionId: string;
  workspaceId: string;
  workspaceRevision: number;
  state: "running" | "succeeded" | "failed" | "cancelled";
  progress?: EditProgress;
  result?: unknown;
  warnings?: string[];
  error?: ReturnType<typeof editErrorData>;
}

export class EditExecutions {
  readonly #jobs = new Map<
    string,
    { status: Execution; controller: AbortController; done: Promise<void> }
  >();

  assertIdle() {
    if ([...this.#jobs.values()].some(({ status }) => status.state === "running"))
      throw new EditError("busy", "A script is already running in this session");
  }

  start(
    workspaceId: string,
    workspaceRevision: number,
    run: (
      signal: AbortSignal,
      progress: (value: EditProgress) => void,
    ) => Promise<{ workspaceRevision: number; result: unknown; warnings?: string[] }>,
  ) {
    this.assertIdle();
    if (this.#jobs.size >= 32) this.#jobs.delete(this.#jobs.keys().next().value as string);
    const status: Execution = {
      executionId: createId(),
      workspaceId,
      workspaceRevision,
      state: "running",
    };
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() =>
        run(controller.signal, (value) => {
          status.progress = value;
        }),
      )
      .then(
        (result) => {
          Object.assign(status, result, { state: "succeeded" });
        },
        (error: unknown) => {
          status.state = controller.signal.aborted ? "cancelled" : "failed";
          status.error = editErrorData(error);
        },
      );
    this.#jobs.set(status.executionId, { status, controller, done });
    return structuredClone(status);
  }

  get(id: string) {
    const job = this.#jobs.get(id);
    if (!job)
      throw new EditError("execution_not_found", "Execution does not exist or its receipt expired");
    return job;
  }

  status(id: string) {
    return structuredClone(this.get(id).status);
  }
  /** Resolves when the execution settles or the wait elapses, whichever comes first. */
  async wait(id: string, waitMs: number) {
    const job = this.get(id);
    if (job.status.state === "running" && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        job.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.status(id);
  }
  async cancel(id: string) {
    const job = this.get(id);
    if (job.status.state === "running") job.controller.abort();
    await job.done;
    return this.status(id);
  }
  interrupt(workspaceId?: string) {
    for (const job of this.#jobs.values())
      if (
        job.status.state === "running" &&
        (!workspaceId || job.status.workspaceId === workspaceId)
      )
        job.controller.abort();
  }
}
