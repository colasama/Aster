import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { startBackgroundEditor } from "./automation-background.js";

export function mediaToolResult(value: unknown): CallToolResult {
  const content: CallToolResult["content"] = [];
  const metadata = JSON.stringify(value, (_key, child: unknown) => {
    if (
      child &&
      typeof child === "object" &&
      "mimeType" in child &&
      "data" in child &&
      typeof child.mimeType === "string" &&
      typeof child.data === "string"
    ) {
      if (child.mimeType.startsWith("image/"))
        content.push({ type: "image", mimeType: child.mimeType, data: child.data });
      else if (child.mimeType.startsWith("audio/"))
        content.push({ type: "audio", mimeType: child.mimeType, data: child.data });
      else return child;
      return { ...child, data: undefined, contentIndex: content.length };
    }
    return child;
  });
  return { content: [{ type: "text", text: metadata ?? "null" }, ...content] };
}

export async function startAsterMcp(
  environment = process.env,
  options: {
    background?: boolean;
    executable?: string;
    launchArgs?: string[];
    onClose?: () => void;
  } = {},
) {
  const background = options.background
    ? await startBackgroundEditor(options.executable ?? process.execPath, options.launchArgs ?? [])
    : undefined;
  const port = background?.port ?? Number(environment.ASTER_AUTOMATION_PORT ?? 48765);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid ASTER_AUTOMATION_PORT");
  const base = `http://127.0.0.1:${port}`;
  const clientId = randomUUID();
  const headers = { "Content-Type": "application/json" };
  const server = new Server(
    { name: "aster", version: "0.3.5" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Operate the running Aster editor. Typical loop: get_editor_context -> describe {topic:'script'} (once) -> execute_aster_code with baseRevision -> render_preview -> commit_workspace.",
        "execute_aster_code runs code (JavaScript with the aster API) or commands (typed batches), waits for completion and returns state, workspaceRevision, result and warnings; get_execution is only needed when a result still says running (cancel:true stops it). Add commit:true to submit and commit in the same call.",
        "commit_workspace submits automatically; submit_workspace only reviews a compact diff. Each commit is one undo step; continue in this connection from the returned projectRevision.",
        "describe finds commands (synonyms work; no query lists all), exact schemas (names) and effect types. script_modules stores helper libraries once for aster.require(name).",
        "query_project kind 'compositions' lists every composition, 'markers' reads beat/section markers, 'workspace' reports budgets. import_assets imports many files at once; relink_source swaps footage. render {action:'export'} then {action:'wait'} renders and flags black output. reference studies local media (contactSheet for overviews); analyze_beats gives BPM/beat grid and writes markers; fonts lists, checks and embeds fonts; diagnostics inspects projects and frames.",
        "render_preview contactSheet reviews a whole span in one image. Read warnings in results: a video layer whose time mapping points outside its source renders black; setLayerTimeMapping offset is the source time shown at inPoint.",
        "Call get_editor_context {reset:true} after external user edits. Use a stable requestId on editing calls and commits for retry deduplication. Idle workspaces keep staged edits until a new workspace needs the slot.",
        "Reference samples return actual timestamps; use those times for motion comparisons.",
      ].join(" "),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const response = await fetch(`${base}/tools`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Aster connection failed (${response.status})`);
    return (await response.json()) as { tools: Tool[] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const cancel = () => {
      void fetch(`${base}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clientId }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    };
    extra.signal.addEventListener("abort", cancel, { once: true });
    try {
      extra.signal.throwIfAborted();
      const response = await fetch(`${base}/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId,
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        }),
        signal: AbortSignal.any([extra.signal, AbortSignal.timeout(125_000)]),
      });
      const body = (await response.json()) as {
        result?: unknown;
        error?: string;
        errorDetails?: unknown;
      };
      if (!response.ok)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                body.errorDetails ?? {
                  code: "transport_error",
                  message: body.error ?? `Aster request failed (${response.status})`,
                },
              ),
            },
          ],
        };
      return mediaToolResult(body.result);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    } finally {
      extra.signal.removeEventListener("abort", cancel);
    }
  });
  const shutdown = () => {
    void server.close();
  };
  process.stdin.once("end", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.onclose = () => {
    process.stdin.off("end", shutdown);
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    void fetch(`${base}/disconnect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId }),
      signal: AbortSignal.timeout(3000),
    })
      .catch(() => undefined)
      .finally(async () => {
        await background?.close();
        options.onClose?.();
      })
      .catch((error: unknown) => {
        process.stderr.write(`MCP shutdown failed: ${String(error)}\n`);
        process.exitCode = 1;
      });
  };
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await background?.close();
    throw error;
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void startAsterMcp(process.env, {
    background: process.argv.includes("--background"),
    executable: process.versions.electron
      ? process.execPath
      : createRequire(import.meta.url)("electron"),
    launchArgs: process.versions.electron
      ? []
      : [resolve(dirname(fileURLToPath(import.meta.url)), "../..")],
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
