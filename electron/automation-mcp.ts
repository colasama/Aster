import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

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

export async function startAsterMcp(environment = process.env) {
  const token = environment.ASTER_AUTOMATION_TOKEN;
  if (!token || token.length < 32)
    throw new Error("Set ASTER_AUTOMATION_TOKEN to the same secret used when launching Aster");
  const port = Number(environment.ASTER_AUTOMATION_PORT ?? 48765);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid ASTER_AUTOMATION_PORT");
  const base = `http://127.0.0.1:${port}`;
  const clientId = randomUUID();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const server = new Server(
    { name: "aster", version: "0.2.1" },
    {
      capabilities: { tools: {} },
      instructions:
        "Operate the running Aster editor. Read context, begin a workspace, discover command schemas, edit, render, submit and commit. Use reset_session after external user edits. Each committed batch is undoable. Reference samples return actual timestamps; use those times for motion comparisons.",
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
      const body = (await response.json()) as { result?: unknown; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Aster request failed (${response.status})`);
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
  server.onclose = () => {
    void fetch(`${base}/disconnect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  };
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void startAsterMcp().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
