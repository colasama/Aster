import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type UtilityProcess, utilityProcess, type WebContents } from "electron";
import type {
  AgentHostEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentToolResponse,
} from "../src/ai/agent-protocol.js";
import { FULL_ACCESS_TOOL_NAMES } from "./full-access-tools.js";
import type { AsterLogger } from "./logger.js";

export type PrivilegedAgentToolHandler = (
  ownerId: number,
  sessionId: string,
  grantId: string | undefined,
  toolName: string,
  argumentsValue: Record<string, unknown>,
) => Promise<unknown>;

interface PendingRun {
  ownerId: number;
  resolve: (result: AgentRunResult) => void;
  reject: (error: Error) => void;
}

type WorkerMessage =
  | { type: "event"; runId: string; event: AgentHostEvent }
  | { type: "tool_request"; runId: string; event: AgentHostEvent }
  | { type: "result"; runId: string; result?: AgentRunResult; error?: string };

export class PiAgentHost {
  readonly #child: UtilityProcess;
  readonly #logger: AsterLogger;
  readonly #runs = new Map<string, PendingRun>();
  readonly #owners = new Map<number, WebContents>();
  readonly #toolOwners = new Map<string, number>();
  readonly #sessionOwners = new Map<string, number>();
  readonly #sessionGrants = new Map<string, string | undefined>();
  readonly #privilegedToolHandler?: PrivilegedAgentToolHandler;
  #disposed = false;

  constructor(logger: AsterLogger, privilegedToolHandler?: PrivilegedAgentToolHandler) {
    this.#logger = logger;
    this.#privilegedToolHandler = privilegedToolHandler;
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "agent-worker.js");
    this.#child = utilityProcess.fork(workerPath, [], {
      serviceName: "Aster Pi Agent",
      stdio: "pipe",
      env: agentEnvironment(),
    });
    this.#child.on("spawn", () =>
      this.#logger.info("agent", "utility_spawned", { pid: this.#child.pid }),
    );
    this.#child.on("message", (message) => this.#receive(message));
    this.#child.on("error", (type, location, report) => {
      this.#logger.error("agent", "utility_error", new Error(type), { location, report });
    });
    this.#child.on("exit", (code) => {
      if (!this.#disposed)
        this.#logger.error("agent", "utility_exited", new Error(`Agent utility exited (${code})`));
      this.#rejectRuns(new Error("Aster Pi agent utility process stopped"));
    });
    this.#child.stderr?.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message)
        this.#logger.warn("agent", "utility_stderr", { message: message.slice(0, 1000) });
    });
  }

  run(owner: WebContents, request: AgentRunRequest): Promise<AgentRunResult> {
    if (this.#disposed) return Promise.reject(new Error("Aster Pi agent is unavailable"));
    const runId = crypto.randomUUID();
    const sessionId = request.sessionId?.trim() || crypto.randomUUID();
    const normalized = { ...request, sessionId };
    this.#owners.set(owner.id, owner);
    this.#sessionOwners.set(sessionId, owner.id);
    this.#sessionGrants.set(sessionId, request.grantId);
    this.#logger.info("agent", "run_started", {
      runId,
      sessionId,
      projectId: request.projectId,
      projectRevision: request.projectRevision,
      model: request.provider.model,
      providerHost: safeHost(request.provider.baseUrl),
      accessMode: request.accessMode,
    });
    return new Promise((resolve, reject) => {
      this.#runs.set(runId, { ownerId: owner.id, resolve, reject });
      this.#child.postMessage({ type: "run", runId, request: normalized });
    });
  }

  respond(owner: WebContents, response: AgentToolResponse): void {
    const ownerId = this.#toolOwners.get(response.requestId);
    if (ownerId !== owner.id) throw new Error("Agent tool response owner does not match");
    this.#toolOwners.delete(response.requestId);
    this.#child.postMessage({ type: "tool_response", response });
  }

  cancel(owner: WebContents, sessionId: string): void {
    if (this.#sessionOwners.get(sessionId) !== owner.id)
      throw new Error("Agent session owner does not match");
    this.#child.postMessage({ type: "cancel", sessionId });
    this.#logger.info("agent", "session_cancelled", { sessionId });
  }

  cancelOwner(ownerId: number): void {
    for (const [sessionId, candidateOwner] of this.#sessionOwners) {
      if (candidateOwner !== ownerId) continue;
      this.#child.postMessage({ type: "cancel", sessionId });
      this.#sessionOwners.delete(sessionId);
      this.#sessionGrants.delete(sessionId);
    }
    this.#owners.delete(ownerId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#child.postMessage({ type: "dispose" });
    this.#child.kill();
    this.#rejectRuns(new Error("Aster Pi agent stopped"));
  }

  #receive(value: unknown): void {
    if (!isWorkerMessage(value)) {
      this.#logger.warn("agent", "invalid_utility_message");
      return;
    }
    const pending = this.#runs.get(value.runId);
    if (!pending) return;
    const owner = this.#owners.get(pending.ownerId);
    if (value.type === "event" || value.type === "tool_request") {
      if (
        value.type === "tool_request" &&
        value.event.type === "tool_request" &&
        FULL_ACCESS_TOOL_NAMES.has(value.event.toolName)
      ) {
        const toolRequest = value.event;
        const handler = this.#privilegedToolHandler;
        if (!handler) {
          this.#child.postMessage({
            type: "tool_response",
            response: {
              requestId: toolRequest.requestId,
              error: "Full Access tools are unavailable",
            },
          });
          return;
        }
        void handler(
          pending.ownerId,
          toolRequest.sessionId,
          this.#sessionGrants.get(toolRequest.sessionId),
          toolRequest.toolName,
          toolRequest.arguments,
        )
          .then((result) =>
            this.#child.postMessage({
              type: "tool_response",
              response: { requestId: toolRequest.requestId, result },
            }),
          )
          .catch((error: unknown) =>
            this.#child.postMessage({
              type: "tool_response",
              response: {
                requestId: toolRequest.requestId,
                error: error instanceof Error ? error.message : String(error),
              },
            }),
          );
        return;
      }
      if (value.event.type === "tool_request")
        this.#toolOwners.set(value.event.requestId, pending.ownerId);
      if (owner && !owner.isDestroyed()) owner.send("aster:agent-event", value.event);
      return;
    }
    this.#runs.delete(value.runId);
    if (value.error) {
      this.#logger.warn("agent", "run_failed", { runId: value.runId, error: value.error });
      pending.reject(new Error(value.error));
    } else if (value.result) {
      this.#logger.info("agent", "run_completed", {
        runId: value.runId,
        sessionId: value.result.sessionId,
        submitted: Boolean(value.result.submittedWorkspaceId),
      });
      pending.resolve(value.result);
    } else {
      pending.reject(new Error("Agent utility returned no result"));
    }
  }

  #rejectRuns(error: Error): void {
    for (const pending of this.#runs.values()) pending.reject(error);
    this.#runs.clear();
    this.#toolOwners.clear();
  }
}

function agentEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "NODE_ENV",
    "ASTER_AI_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerMessage>;
  return (
    typeof candidate.type === "string" &&
    ["event", "tool_request", "result"].includes(candidate.type) &&
    typeof candidate.runId === "string"
  );
}
