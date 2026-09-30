import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../src/ai/agent-protocol";
import { PiAgentRuntime } from "./agent-runtime";

const request: AgentRunRequest = {
  prompt: "Rename the selected layer",
  projectId: "project-1",
  projectName: "Test",
  projectRevision: 3,
  accessMode: "agent",
  provider: {
    baseUrl: "https://provider.example/v1",
    apiKey: "test-key",
    model: "test-model",
    supportsImages: false,
  },
};

describe("Pi agent runtime", () => {
  it("runs a persistent tool loop with only Aster-owned meta-tools", async () => {
    const faux = createFauxCore({ provider: "aster-openai-compatible" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("get_editor_context", {}, { id: "tool-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("describe", { topic: "commands", query: "rename layer" }, { id: "tool-2" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "execute_aster_code",
          {
            baseRevision: 3,
            commands: [{ type: "renameLayer", layerId: "layer-1", name: "Renamed" }],
          },
          { id: "tool-3" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "submit_workspace",
          { workspaceId: "workspace-1", workspaceRevision: 1, summary: "Rename layer" },
          { id: "tool-4" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("The staged rename is ready for review.")),
    ]);
    const toolNames: string[] = [];
    const events: string[] = [];
    const runtime = new PiAgentRuntime(
      async (_sessionId, toolName) => {
        toolNames.push(toolName);
        if (toolName === "describe") return { commands: [{ name: "renameLayer" }] };
        if (toolName === "execute_aster_code")
          return { workspaceId: "workspace-1", workspaceRevision: 1 };
        if (toolName === "submit_workspace") return { workspaceId: "workspace-1" };
        return { projectRevision: 3 };
      },
      (event) => events.push(event.type),
      { streamFn: faux.streamSimple },
    );
    const result = await runtime.run(request);
    expect(toolNames).toEqual([
      "get_editor_context",
      "describe",
      "execute_aster_code",
      "submit_workspace",
    ]);
    expect(result.submittedWorkspaceId).toBe("workspace-1");
    expect(result.text).toContain("ready for review");
    expect(events).toContain("tool_started");
    expect(events).toContain("text_delta");
  });

  it("rejects unsafe provider URLs before starting Pi", async () => {
    const runtime = new PiAgentRuntime(
      async () => ({}),
      () => undefined,
    );
    await expect(
      runtime.run({
        ...request,
        provider: { ...request.provider, baseUrl: "http://provider.example/v1" },
      }),
    ).rejects.toThrow("HTTPS");
  });

  it("registers privileged tools only for an effective Full Access run", async () => {
    const faux = createFauxCore({ provider: "aster-openai-compatible" });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read_file", { path: "C:/safe-test.txt" }, { id: "full-tool" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("Read complete")),
      fauxAssistantMessage(
        fauxToolCall("install_plugin", { source: "C:/unavailable-plugin" }, { id: "blocked-tool" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("No privileged tool was available")),
    ]);
    const calls: string[] = [];
    const runtime = new PiAgentRuntime(
      async (_sessionId, toolName) => {
        calls.push(toolName);
        return { content: "test" };
      },
      () => undefined,
      { streamFn: faux.streamSimple },
    );
    await runtime.run({ ...request, accessMode: "full_access", grantId: "grant-1" });
    await runtime.run({ ...request, sessionId: "agent-only", accessMode: "agent" });
    expect(calls).toEqual(["read_file"]);
  });

  it("attaches preview images only when trusted model metadata enables image input", async () => {
    for (const supportsImages of [true, false]) {
      const faux = createFauxCore({ provider: "aster-openai-compatible" });
      let imageBlocks = -1;
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "render_preview",
            { workspaceId: "workspace-1", workspaceRevision: 0, times: [0] },
            { id: `preview-${supportsImages}` },
          ),
          { stopReason: "toolUse" },
        ),
        (context) => {
          const toolResult = context.messages.findLast((message) => message.role === "toolResult");
          imageBlocks =
            toolResult?.role === "toolResult"
              ? toolResult.content.filter((block) => block.type === "image").length
              : -1;
          return fauxAssistantMessage(fauxText("Preview received"));
        },
      ]);
      const runtime = new PiAgentRuntime(
        async () => ({
          status: "rendered",
          frames: [
            {
              time: 0,
              renderId: "render-1",
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
              width: 64,
              height: 64,
            },
          ],
        }),
        () => undefined,
        { streamFn: faux.streamSimple },
      );
      await runtime.run({
        ...request,
        sessionId: `preview-session-${supportsImages}`,
        provider: { ...request.provider, supportsImages },
      });
      expect(imageBlocks).toBe(supportsImages ? 1 : 0);
    }
  });
});
