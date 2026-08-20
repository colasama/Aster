import type { CpuTaskRequest, CpuTaskResponse } from "./cpu-task-protocol";
import { serializeCpuTaskError } from "./cpu-task-protocol";
import { executeCpuTask } from "./cpu-task-runner";

interface CpuWorkerScope {
  onmessage: ((event: MessageEvent<CpuTaskRequest>) => void) | null;
  postMessage(message: CpuTaskResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as CpuWorkerScope;

scope.onmessage = (event) => {
  const { id, task } = event.data;
  try {
    const result = executeCpuTask(task);
    const transfer = result instanceof Float32Array ? [result.buffer] : undefined;
    scope.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    scope.postMessage({ error: serializeCpuTaskError(error), id, ok: false });
  }
};
