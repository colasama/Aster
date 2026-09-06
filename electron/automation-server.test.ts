import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaToolResult } from "./automation-mcp";
import { startAutomationServer } from "./automation-server";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function fixture(execute = vi.fn(async () => ({ ok: true })), cancel = vi.fn()) {
  const token = randomBytes(32).toString("hex");
  const server = await startAutomationServer({ port: 0, token, execute, cancel });
  closers.push(server.close);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { execute, cancel, headers, base: `http://127.0.0.1:${server.port}` };
}

describe("external automation boundary", () => {
  it("rejects unauthenticated and browser-origin requests, then exposes shared schemas", async () => {
    const { base, headers } = await fixture();
    expect((await fetch(`${base}/tools`)).status).toBe(403);
    expect(
      (await fetch(`${base}/tools`, { headers: { ...headers, origin: "https://example.com" } }))
        .status,
    ).toBe(403);
    const result = await (await fetch(`${base}/tools`, { headers })).json();
    expect(result.tools.some((tool: { name: string }) => tool.name === "execute_commands")).toBe(
      true,
    );
    expect(result.tools.some((tool: { name: string }) => tool.name === "compare_reference")).toBe(
      true,
    );
  });

  it("rejects invalid arguments before dispatch and runs bounded valid commands", async () => {
    const { base, headers, execute } = await fixture();
    const call = (args: unknown) =>
      fetch(`${base}/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clientId: "test", name: "read_reference_frames", arguments: args }),
      });
    expect((await call({ path: "test.mp4", times: [0], maxDimension: 99999 })).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    const response = await call({ path: "test.mp4", times: [0], maxDimension: 1024 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { ok: true } });
  });

  it("propagates cancellation while a call is active", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = vi.fn(
      (_call, signal: AbortSignal) =>
        new Promise<{ ok: boolean }>((_resolve, reject) => {
          entered();
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const { base, headers, cancel } = await fixture(execute);
    const pending = fetch(`${base}/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId: "test", name: "get_editor_context", arguments: {} }),
    });
    await started;
    expect(
      (
        await fetch(`${base}/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify({ clientId: "test" }),
        })
      ).status,
    ).toBe(200);
    expect((await pending).status).toBe(400);
    expect(cancel).toHaveBeenCalledWith("test");
  });

  it("routes media as native MCP content rather than duplicating base64 in text", () => {
    const result = mediaToolResult({
      frames: [{ time: 0.5, mimeType: "image/png", data: "aGVsbG8=" }],
      audio: { mimeType: "audio/wav", data: "d2F2" },
    });
    expect(result.content.map((item) => item.type)).toEqual(["text", "image", "audio"]);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.not.stringContaining("aGVsbG8="),
    });
  });
});
