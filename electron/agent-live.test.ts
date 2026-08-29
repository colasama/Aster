import { describe, expect, it } from "vitest";
import { AsterAgentApplicationService } from "../src/ai/application-service";
import { createBlankProject } from "../src/core/project";
import { PiAgentRuntime } from "./agent-runtime";

const live = process.env.ASTER_AI_LIVE_TEST === "1";

describe.runIf(live)("Pi agent live provider", () => {
  it("completes a real multi-tool staged edit without mutating the live project", async () => {
    const apiKey = process.env.ASTER_AI_API_KEY;
    if (!apiKey) throw new Error("ASTER_AI_API_KEY is required for the live test");
    const project = createBlankProject();
    const selectedLayerId = project.compositions[0].layers[0].id;
    const originalName = project.compositions[0].layers[0].name;
    const service = new AsterAgentApplicationService({
      project,
      projectRevision: 11,
      selection: [selectedLayerId],
      currentTime: 0,
      accessMode: "agent",
      primaryModelSupportsImages: false,
    });
    const runtime = new PiAgentRuntime(
      (_sessionId, toolName, argumentsValue) => service.executeTool(toolName, argumentsValue),
      () => undefined,
    );
    const result = await runtime.run({
      prompt:
        'Rename the selected layer to "Live Agent Title". Make no other project changes. Analyze time 0 and submit the workspace.',
      projectId: project.id,
      projectName: project.name,
      projectRevision: 11,
      accessMode: "agent",
      provider: {
        baseUrl: process.env.ASTER_AI_BASE_URL ?? "https://88996api.cloud/v1",
        apiKey,
        model: process.env.ASTER_AI_MODEL ?? "deepseek-v4-flash-0731",
        supportsImages: false,
      },
    });
    const submitted = service.submittedWorkspace();
    expect(result.submittedWorkspaceId).toBe(submitted?.workspaceId);
    expect(submitted?.operations).toHaveLength(1);
    expect(submitted?.operations[0]).toMatchObject({
      type: "renameLayer",
      layerId: selectedLayerId,
      name: "Live Agent Title",
    });
    expect(project.compositions[0].layers[0].name).toBe(originalName);
    expect(service.auditEvents().some((event) => event.toolName === "submit_workspace")).toBe(true);
  }, 90_000);
});
