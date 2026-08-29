import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  type ImageContent,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { Type } from "typebox";
import type { AgentHostEvent, AgentRunRequest, AgentRunResult } from "../src/ai/agent-protocol.js";

const MAX_PROMPT_CHARS = 32_000;
const MAX_SESSION_MESSAGES = 64;

export type AgentToolHandler = (
  sessionId: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export type AgentEventHandler = (event: AgentHostEvent) => void;

interface AgentSession {
  agent: Agent;
  projectId: string;
  providerFingerprint: string;
  submittedWorkspaceId?: string;
}

export interface PiAgentRuntimeOptions {
  streamFn?: StreamFn;
}

export class PiAgentRuntime {
  readonly #sessions = new Map<string, AgentSession>();
  readonly #streamFn: StreamFn;

  constructor(
    readonly toolHandler: AgentToolHandler,
    readonly eventHandler: AgentEventHandler,
    options: PiAgentRuntimeOptions = {},
  ) {
    this.#streamFn =
      options.streamFn ??
      ((model, context, streamOptions) =>
        streamOpenAiCompletions(model as Model<"openai-completions">, context, streamOptions));
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    validateRequest(request);
    const sessionId = request.sessionId?.trim() || crypto.randomUUID();
    const fingerprint = providerFingerprint(request);
    let session = this.#sessions.get(sessionId);
    if (
      !session ||
      session.projectId !== request.projectId ||
      session.providerFingerprint !== fingerprint
    ) {
      session = this.#createSession(sessionId, request, fingerprint);
      this.#sessions.set(sessionId, session);
    } else {
      session.agent.state.systemPrompt = systemPrompt(request);
      session.agent.getApiKey = async () => request.provider.apiKey ?? process.env.ASTER_AI_API_KEY;
      session.submittedWorkspaceId = undefined;
      pruneMessages(session.agent);
    }
    await session.agent.prompt(request.prompt.trim());
    const error = session.agent.state.errorMessage;
    if (error) throw new Error(error);
    const message = [...session.agent.state.messages]
      .reverse()
      .find((candidate) => candidate.role === "assistant");
    return {
      sessionId,
      text: message?.role === "assistant" ? contentText(message.content) : "",
      submittedWorkspaceId: session.submittedWorkspaceId,
    };
  }

  abort(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    session?.agent.abort();
    session?.agent.clearAllQueues();
  }

  dispose(): void {
    for (const session of this.#sessions.values()) session.agent.abort();
    this.#sessions.clear();
  }

  #createSession(sessionId: string, request: AgentRunRequest, fingerprint: string): AgentSession {
    const session: AgentSession = {
      projectId: request.projectId,
      providerFingerprint: fingerprint,
      submittedWorkspaceId: undefined,
      agent: undefined as unknown as Agent,
    };
    const executeTool = async (
      toolName: string,
      argumentsValue: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      const result = await this.toolHandler(sessionId, toolName, argumentsValue, signal);
      if (
        toolName === "submit_workspace" &&
        isRecord(result) &&
        typeof result.workspaceId === "string"
      )
        session.submittedWorkspaceId = result.workspaceId;
      return result;
    };
    const tools = [
      ...createAsterTools(executeTool, request.provider.supportsImages),
      ...(request.accessMode === "full_access" ? createFullAccessTools(executeTool) : []),
    ];
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(request),
        model: providerModel(request),
        thinkingLevel: "off",
        tools,
        messages: [],
      },
      streamFn: this.#streamFn,
      getApiKey: async () => request.provider.apiKey ?? process.env.ASTER_AI_API_KEY,
      sessionId,
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }) => {
        if (!tools.some((tool) => tool.name === toolCall.name))
          return { block: true, reason: "Tool is outside the Aster allowlist", terminate: true };
        return undefined;
      },
    });
    session.agent = agent;
    agent.subscribe((event) => this.#forwardEvent(sessionId, event));
    return session;
  }

  #forwardEvent(sessionId: string, event: AgentEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.eventHandler({
        type: "text_delta",
        sessionId,
        delta: event.assistantMessageEvent.delta,
      });
    } else if (event.type === "tool_execution_start") {
      this.eventHandler({ type: "tool_started", sessionId, toolName: event.toolName });
    } else if (event.type === "tool_execution_end") {
      this.eventHandler({
        type: "tool_finished",
        sessionId,
        toolName: event.toolName,
        isError: event.isError,
      });
    }
  }
}

function createAsterTools(
  execute: (
    toolName: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>,
  supportsImages: boolean,
): AgentTool[] {
  const revision = Type.Integer({ minimum: 0 });
  const workspaceFields = {
    workspaceId: Type.String({ minLength: 1 }),
    workspaceRevision: revision,
  };
  const definitions: Array<{
    name: string;
    label: string;
    description: string;
    parameters: AgentTool["parameters"];
  }> = [
    {
      name: "get_editor_context",
      label: "Get editor context",
      description:
        "Read the live project revision, active composition, selection, access mode, and capability categories.",
      parameters: Type.Object({}, { additionalProperties: false }),
    },
    {
      name: "search_capabilities",
      label: "Search capabilities",
      description:
        "Find concise Aster command descriptors by intent or category before loading schemas.",
      parameters: Type.Object(
        {
          query: Type.String({ maxLength: 500 }),
          category: Type.Optional(Type.String({ maxLength: 100 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "get_command_schemas",
      label: "Get command schemas",
      description: "Load exact input schemas for 1 through 12 discovered Aster commands.",
      parameters: Type.Object(
        { names: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }) },
        { additionalProperties: false },
      ),
    },
    {
      name: "query_project",
      label: "Query project",
      description: "Read a filtered, paginated, byte-bounded project view at a declared revision.",
      parameters: Type.Object(
        {
          projectRevision: Type.Optional(revision),
          workspaceId: Type.Optional(Type.String({ minLength: 1 })),
          kind: Type.Union([
            Type.Literal("project"),
            Type.Literal("compositions"),
            Type.Literal("layers"),
            Type.Literal("properties"),
            Type.Literal("effects"),
            Type.Literal("assets"),
            Type.Literal("scene"),
          ]),
          time: Type.Optional(Type.Number({ minimum: 0 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "begin_edit_workspace",
      label: "Begin edit workspace",
      description: "Create an isolated staged project branch from the exact live project revision.",
      parameters: Type.Object({ baseRevision: revision }, { additionalProperties: false }),
    },
    {
      name: "execute_commands",
      label: "Execute commands",
      description:
        "Atomically validate and execute 1 through 12 typed commands in a staged workspace.",
      parameters: Type.Object(
        {
          ...workspaceFields,
          commands: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
            minItems: 1,
            maxItems: 12,
          }),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "evaluate_at_time",
      label: "Evaluate at time",
      description:
        "Evaluate staged semantic properties and scene state at an explicit time without playback history.",
      parameters: Type.Object(
        { ...workspaceFields, time: Type.Number({ minimum: 0, maximum: 86_400 }) },
        { additionalProperties: false },
      ),
    },
    {
      name: "render_preview",
      label: "Render preview",
      description:
        "Request bounded, deterministic preview samples and report an explicit unverified result if pixels are unavailable.",
      parameters: Type.Object(
        {
          ...workspaceFields,
          times: Type.Array(Type.Number({ minimum: 0, maximum: 86_400 }), {
            minItems: 1,
            maxItems: 12,
          }),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "analyze_render",
      label: "Analyze render",
      description:
        "Run native vision when available or deterministic semantic metrics with explicit limitations.",
      parameters: Type.Object(
        {
          ...workspaceFields,
          times: Type.Array(Type.Number({ minimum: 0, maximum: 86_400 }), {
            minItems: 1,
            maxItems: 12,
          }),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "inspect_diagnostics",
      label: "Inspect diagnostics",
      description: "Inspect bounded project, asset, timing, plugin, and render diagnostics.",
      parameters: Type.Object(
        { workspaceId: Type.Optional(Type.String({ minLength: 1 })) },
        { additionalProperties: false },
      ),
    },
    {
      name: "submit_workspace",
      label: "Submit workspace",
      description:
        "Freeze the cumulative staged result and send its semantic diff to Aster for approval or commit.",
      parameters: Type.Object(
        { ...workspaceFields, summary: Type.String({ minLength: 1, maxLength: 500 }) },
        { additionalProperties: false },
      ),
    },
    {
      name: "discard_workspace",
      label: "Discard workspace",
      description: "Destroy an abandoned staged workspace without changing the live project.",
      parameters: Type.Object(
        { workspaceId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    },
  ];
  return definitions.map((definition) => ({
    ...definition,
    executionMode: "sequential" as const,
    execute: async (_toolCallId, parameters, signal) => {
      const result = await execute(
        definition.name,
        parameters as Record<string, unknown>,
        signal ?? new AbortController().signal,
      );
      return {
        content: asterToolResultContent(definition.name, result, supportsImages),
        details: {},
      };
    },
  }));
}

function createFullAccessTools(
  execute: (
    toolName: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>,
): AgentTool[] {
  const definitions: Array<{
    name: string;
    label: string;
    description: string;
    parameters: AgentTool["parameters"];
  }> = [
    {
      name: "read_file",
      label: "Read file (Full Access)",
      description: "Read an explicitly named accessible UTF-8 file up to 64 KiB. Full Access only.",
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "write_file",
      label: "Write file (Full Access)",
      description:
        "Create, overwrite, or append an explicitly named UTF-8 file. This can be irreversible.",
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          content: Type.String({ maxLength: 1_048_576 }),
          mode: Type.Optional(
            Type.Union([Type.Literal("create"), Type.Literal("overwrite"), Type.Literal("append")]),
          ),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "delete_path",
      label: "Delete path (Full Access)",
      description:
        "Delete one exact file or empty directory. This is destructive and irreversible.",
      parameters: Type.Object(
        { path: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    },
    {
      name: "run_process",
      label: "Run process (Full Access)",
      description:
        "Run an executable directly without a shell, with bounded time and output. Full Access only.",
      parameters: Type.Object(
        {
          executable: Type.String({ minLength: 1 }),
          args: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
          cwd: Type.Optional(Type.String({ minLength: 1 })),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "network_request",
      label: "Network request (Full Access)",
      description:
        "Make one bounded HTTP(S) request. Project data in the body may leave the device.",
      parameters: Type.Object(
        {
          url: Type.String({ minLength: 1 }),
          method: Type.Optional(
            Type.Union([
              Type.Literal("GET"),
              Type.Literal("POST"),
              Type.Literal("PUT"),
              Type.Literal("PATCH"),
              Type.Literal("DELETE"),
            ]),
          ),
          body: Type.Optional(Type.String({ maxLength: 1_048_576 })),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30_000 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "get_plugin_status",
      label: "Get plugin status (Full Access)",
      description: "Read installed plugin, safe-mode, and hot-reload status. Full Access only.",
      parameters: Type.Object({}, { additionalProperties: false }),
    },
    {
      name: "install_plugin",
      label: "Install plugin (Full Access)",
      description:
        "Install a plugin from one exact local directory through Aster's validated plugin service.",
      parameters: Type.Object(
        { source: Type.String({ minLength: 1, maxLength: 32_768 }) },
        { additionalProperties: false },
      ),
    },
    {
      name: "set_plugin_enabled",
      label: "Enable plugin (Full Access)",
      description: "Enable or disable one installed plugin by ID.",
      parameters: Type.Object(
        { pluginId: Type.String({ minLength: 1, maxLength: 256 }), enabled: Type.Boolean() },
        { additionalProperties: false },
      ),
    },
    {
      name: "set_plugin_safe_mode",
      label: "Set plugin safe mode (Full Access)",
      description: "Enable or disable Aster plugin safe mode.",
      parameters: Type.Object({ safeMode: Type.Boolean() }, { additionalProperties: false }),
    },
    {
      name: "set_plugin_hot_reload",
      label: "Set plugin hot reload (Full Access)",
      description: "Enable or disable the validated plugin hot-reload watcher.",
      parameters: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
    },
    {
      name: "pack_project",
      label: "Pack project (Full Access)",
      description: "Pack one saved Aster project bundle to an exact .aster destination.",
      parameters: Type.Object(
        {
          bundle: Type.String({ minLength: 1, maxLength: 32_768 }),
          destination: Type.String({ minLength: 1, maxLength: 32_768 }),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "unpack_project",
      label: "Unpack project (Full Access)",
      description: "Unpack one exact .aster archive below an exact parent directory.",
      parameters: Type.Object(
        {
          archive: Type.String({ minLength: 1, maxLength: 32_768 }),
          parent: Type.String({ minLength: 1, maxLength: 32_768 }),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "link_project_asset",
      label: "Link project asset (Full Access)",
      description:
        "Copy or link one image/video into a saved Aster project bundle through its asset service.",
      parameters: Type.Object(
        {
          bundle: Type.String({ minLength: 1, maxLength: 32_768 }),
          source: Type.String({ minLength: 1, maxLength: 32_768 }),
          kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
        },
        { additionalProperties: false },
      ),
    },
  ];
  return definitions.map((definition) => ({
    ...definition,
    executionMode: "sequential" as const,
    execute: async (_toolCallId, parameters, signal) => {
      const result = await execute(
        definition.name,
        parameters as Record<string, unknown>,
        signal ?? new AbortController().signal,
      );
      return {
        content: [{ type: "text" as const, text: boundedJson(result) }],
        details: {},
      };
    },
  }));
}

function providerModel(request: AgentRunRequest): Model<"openai-completions"> {
  return {
    id: request.provider.model,
    name: request.provider.model,
    api: "openai-completions",
    provider: "aster-openai-compatible",
    baseUrl: request.provider.baseUrl.replace(/\/+$/u, ""),
    reasoning: false,
    input: request.provider.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };
}

function systemPrompt(request: AgentRunRequest): string {
  const authority =
    request.accessMode === "full_access"
      ? "A user-activated Full Access grant also exposes bounded file, process, network, plugin, project-package, and asset-link tools. Use them only when semantic Aster commands or dedicated services cannot satisfy the request."
      : "You have no coding, shell, filesystem, network, plugin, or raw project tools.";
  return `You are the Pi agent runtime inside Aster, a GPU-first motion graphics editor.
Project: ${request.projectName} (${request.projectId}), live revision ${request.projectRevision}.
Access mode: ${request.accessMode}.

Use only the provided Aster tools. ${authority}
Start by calling get_editor_context. Discover commands with search_capabilities and load only the exact schemas you need. Query IDs instead of inventing them. Begin one edit workspace at the declared live revision, execute small atomic command batches, evaluate at explicit times, inspect diagnostics, and analyze meaningful bounded samples. Submit exactly one non-empty workspace when the requested edit is ready. If the task cannot be completed safely, discard the workspace and explain why.

Correctness and authorization are enforced by Aster, not by this prompt. Never request or reveal secrets. Prefer Aster commands over external side effects. Deterministic metrics cannot claim subjective visual quality or native vision. Keep the final response concise and state any visual-verification limitation.`;
}

function providerFingerprint(request: AgentRunRequest): string {
  return `${request.provider.baseUrl}\0${request.provider.model}\0${request.provider.supportsImages}\0${request.accessMode}\0${request.grantId ?? ""}`;
}

function validateRequest(request: AgentRunRequest): void {
  if (!request.prompt.trim() || request.prompt.length > MAX_PROMPT_CHARS)
    throw new Error("Agent prompt must contain 1 through 32000 characters");
  const baseUrl = new URL(request.provider.baseUrl);
  if (
    baseUrl.protocol !== "https:" &&
    !(
      baseUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)
    )
  )
    throw new Error("Agent provider must use HTTPS or loopback HTTP");
  if (!request.provider.model.trim()) throw new Error("Agent model is required");
  if (!request.provider.apiKey?.trim() && !process.env.ASTER_AI_API_KEY)
    throw new Error("Agent provider API key is not configured");
  if (!Number.isSafeInteger(request.projectRevision) || request.projectRevision < 0)
    throw new Error("Project revision is invalid");
}

function pruneMessages(agent: Agent): void {
  if (agent.state.messages.length <= MAX_SESSION_MESSAGES) return;
  agent.state.messages = agent.state.messages.slice(-MAX_SESSION_MESSAGES);
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 96 * 1024)
    throw new Error("Agent tool result exceeded its protocol budget");
  return serialized;
}

function asterToolResultContent(
  toolName: string,
  value: unknown,
  supportsImages: boolean,
): Array<TextContent | ImageContent> {
  if (toolName !== "render_preview" || !isRecord(value) || !Array.isArray(value.frames))
    return [{ type: "text", text: boundedJson(value) }];
  const images: ImageContent[] = [];
  const frames = value.frames.map((entry) => {
    if (!isRecord(entry)) return entry;
    const { data, ...metadata } = entry;
    if (
      supportsImages &&
      typeof data === "string" &&
      typeof entry.mimeType === "string" &&
      data.length <= 12 * 1024 * 1024
    )
      images.push({ type: "image", data, mimeType: entry.mimeType });
    return metadata;
  });
  return [
    { type: "text", text: boundedJson({ ...value, frames }) },
    ...(supportsImages ? images : []),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
