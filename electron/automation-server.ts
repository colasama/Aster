import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Check } from "typebox/value";
import { automationToolDefinitions } from "../src/ai/automation-protocol.js";
import { editErrorData } from "../src/ai/edit-limits.js";

export interface AutomationCall {
  clientId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export async function startAutomationServer(options: {
  port: number;
  execute: (call: AutomationCall, signal: AbortSignal) => Promise<unknown>;
  cancel: (clientId: string, discard?: boolean) => void;
}) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error("Invalid Aster automation port");
  const definitions = automationToolDefinitions();
  const active = new Map<string, AbortController>();
  const sessions = new Set<string>();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.destroyed)
        send(response, 400, {
          error: error instanceof Error ? error.message : String(error),
          errorDetails: editErrorData(error),
        });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (
      request.headers.origin ||
      request.headers.host !== `127.0.0.1:${port}` ||
      request.headers["sec-fetch-site"] ||
      (request.method === "POST" && request.headers["content-type"] !== "application/json")
    ) {
      send(response, 403, { error: "Aster automation requires a local non-browser client" });
      request.resume();
      return;
    }
    if (request.method === "GET" && request.url === "/tools") {
      send(response, 200, {
        tools: definitions.map(({ name, description, parameters }) => ({
          name,
          description,
          inputSchema: parameters,
        })),
      });
      return;
    }
    if (
      request.method !== "POST" ||
      !["/call", "/cancel", "/disconnect"].includes(request.url ?? "")
    ) {
      send(response, 404, { error: "Unknown automation endpoint" });
      request.resume();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 1024 * 1024)
        throw new Error("Automation request exceeds 1 MiB");
    }
    const value = JSON.parse(body) as AutomationCall;
    if (!value || typeof value.clientId !== "string" || !/^[\w-]{1,80}$/.test(value.clientId))
      throw new Error("Invalid automation client ID");
    if (request.url !== "/call") {
      active.get(value.clientId)?.abort();
      options.cancel(value.clientId, request.url === "/disconnect");
      if (request.url === "/disconnect") sessions.delete(value.clientId);
      send(response, 200, { cancelled: true });
      return;
    }
    const definition = definitions.find((tool) => tool.name === value.name);
    if (!definition || !Check(definition.parameters, value.arguments))
      throw new Error("Unknown tool or arguments do not match its schema");
    if (active.size) {
      send(response, 409, {
        error: "Aster automation is busy; retry after the current call completes",
      });
      return;
    }
    if (!sessions.has(value.clientId) && sessions.size >= 8)
      throw new Error("Aster supports at most eight external clients");
    sessions.add(value.clientId);
    const controller = new AbortController();
    active.set(value.clientId, controller);
    const cancel = () => {
      if (!response.writableEnded) {
        controller.abort();
        options.cancel(value.clientId);
      }
    };
    response.on("close", cancel);
    const timer = setTimeout(() => {
      controller.abort();
      options.cancel(value.clientId);
    }, 120_000);
    try {
      const result = await options.execute(value, controller.signal);
      controller.signal.throwIfAborted();
      const encoded = JSON.stringify({ result });
      if (Buffer.byteLength(encoded) > 48 * 1024 * 1024)
        throw new Error("Automation result exceeds 48 MiB");
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(encoded);
    } finally {
      clearTimeout(timer);
      response.off("close", cancel);
      active.delete(value.clientId);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Automation listener has no TCP address");
  const port = address.port;
  return {
    port,
    status: () => ({ clients: sessions.size, busy: active.size > 0 }),
    close: async () => {
      for (const [id, controller] of active) {
        controller.abort();
        options.cancel(id);
      }
      for (const id of sessions) options.cancel(id, true);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
