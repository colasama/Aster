import type {
  AgentHostEvent,
  AgentRunRequest,
  AgentToolResponse,
} from "../src/ai/agent-protocol.js";
import { PiAgentRuntime } from "./agent-runtime.js";

type ParentMessage =
  | { type: "run"; runId: string; request: AgentRunRequest }
  | { type: "tool_response"; response: AgentToolResponse }
  | { type: "cancel"; sessionId: string }
  | { type: "dispose" };

interface PendingTool {
  sessionId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Aster Pi agent must run in an Electron utility process");

const pendingTools = new Map<string, PendingTool>();
let activeRunId: string | undefined;

const runtime = new PiAgentRuntime(
  (sessionId, toolName, argumentsValue, signal) =>
    new Promise((resolve, reject) => {
      if (!activeRunId) {
        reject(new Error("Agent run is unavailable"));
        return;
      }
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pendingTools.delete(requestId);
        reject(new Error(`Aster tool timed out: ${toolName}`));
      }, 30_000);
      pendingTools.set(requestId, { sessionId, resolve, reject, timeout });
      signal.addEventListener(
        "abort",
        () => {
          const pending = pendingTools.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timeout);
          pendingTools.delete(requestId);
          pending.reject(new Error("Aster tool was cancelled"));
        },
        { once: true },
      );
      post({
        type: "tool_request",
        runId: activeRunId,
        event: {
          type: "tool_request",
          requestId,
          sessionId,
          toolName,
          arguments: argumentsValue,
        } satisfies AgentHostEvent,
      });
    }),
  (event) => {
    if (activeRunId) post({ type: "event", runId: activeRunId, event });
  },
);

parentPort.on("message", (messageEvent) => {
  const message = messageEvent.data as ParentMessage;
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "run") {
    if (activeRunId) {
      post({ type: "result", runId: message.runId, error: "Aster Pi agent is already running" });
      return;
    }
    activeRunId = message.runId;
    void runtime
      .run(message.request)
      .then((result) => post({ type: "result", runId: message.runId, result }))
      .catch((error: unknown) =>
        post({
          type: "result",
          runId: message.runId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        activeRunId = undefined;
      });
  } else if (message.type === "tool_response") {
    settleTool(message.response);
  } else if (message.type === "cancel") {
    runtime.abort(message.sessionId);
    rejectSessionTools(message.sessionId, "Agent session was cancelled");
  } else if (message.type === "dispose") {
    runtime.dispose();
    rejectAllTools("Agent utility process is stopping");
  }
});

function settleTool(response: AgentToolResponse): void {
  const pending = pendingTools.get(response.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingTools.delete(response.requestId);
  if (response.error) pending.reject(new Error(response.error));
  else pending.resolve(response.result);
}

function rejectSessionTools(sessionId: string, message: string): void {
  for (const [requestId, pending] of pendingTools) {
    if (pending.sessionId !== sessionId) continue;
    clearTimeout(pending.timeout);
    pendingTools.delete(requestId);
    pending.reject(new Error(message));
  }
}

function rejectAllTools(message: string): void {
  for (const pending of pendingTools.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  pendingTools.clear();
}

function post(message: unknown): void {
  parentPort?.postMessage(message);
}
