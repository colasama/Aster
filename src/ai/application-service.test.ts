import { describe, expect, it } from "vitest";
import { createBlankProject } from "../core/project/project";
import { AsterAgentApplicationService } from "./application-service";
import type { AgentRenderedPreviewFrame } from "./render-preview";

function createService(projectRevision = 7) {
  const project = createBlankProject();
  return {
    project,
    service: new AsterAgentApplicationService({
      project,
      projectRevision,
      selection: [project.compositions[0].layers[0].id],
      currentTime: 0,
      accessMode: "agent",
      primaryModelSupportsImages: false,
    }),
  };
}

describe("Aster agent application service", () => {
  it("discovers schemas on demand and keeps query results revision-addressed", async () => {
    const { service } = createService();
    const discovered = (await service.executeTool("search_capabilities", {
      query: "rename",
    })) as { commands: Array<{ name: string }> };
    expect(discovered.commands.map(({ name }) => name)).toEqual([
      "renameLayer",
      "renameProjectItem",
    ]);
    const complexSchema = (await service.executeTool("get_command_schemas", {
      names: ["setShapeGraph"],
    })) as { commands: Array<{ inputSchema: unknown }> };
    expect(JSON.stringify(complexSchema.commands[0].inputSchema)).not.toContain("$ref");
    const queried = (await service.executeTool("query_project", {
      projectRevision: 7,
      kind: "layers",
    })) as { projectRevision: number; items: unknown[] };
    expect(queried.projectRevision).toBe(7);
    expect(queried.items.length).toBeGreaterThan(0);
  });

  it("rejects stale revisions and keeps command batches atomic", async () => {
    const { project, service } = createService();
    await expect(service.executeTool("begin_edit_workspace", { baseRevision: 6 })).rejects.toThrow(
      "Stale project revision",
    );
    const begun = (await service.executeTool("begin_edit_workspace", {
      baseRevision: 7,
    })) as { workspaceId: string; workspaceRevision: number };
    await expect(
      service.executeTool("execute_commands", {
        workspaceId: begun.workspaceId,
        workspaceRevision: begun.workspaceRevision,
        commands: [
          {
            type: "renameLayer",
            layerId: project.compositions[0].layers[0].id,
            name: "Staged",
          },
          {
            type: "removeEffect",
            layerId: project.compositions[0].layers[0].id,
            effectId: "missing",
          },
        ],
      }),
    ).rejects.toThrow("Effect does not exist");
    const queried = (await service.executeTool("query_project", {
      workspaceId: begun.workspaceId,
      kind: "layers",
    })) as { items: Array<{ name: string }> };
    expect(queried.items[0].name).not.toBe("Staged");

    const executed = (await service.executeTool("execute_commands", {
      workspaceId: begun.workspaceId,
      workspaceRevision: begun.workspaceRevision,
      commands: [
        {
          type: "renameLayer",
          layerId: project.compositions[0].layers[0].id,
          name: "Committed to workspace",
        },
      ],
    })) as { workspaceRevision: number };
    expect(executed.workspaceRevision).toBe(1);
    await expect(
      service.executeTool("execute_commands", {
        workspaceId: begun.workspaceId,
        workspaceRevision: 0,
        commands: [
          {
            type: "renameLayer",
            layerId: project.compositions[0].layers[0].id,
            name: "Stale overwrite",
          },
        ],
      }),
    ).rejects.toThrow("Stale workspace revision");
  });

  it("submits cumulative edits as one frozen, auditable workspace", async () => {
    const { project, service } = createService();
    const layerId = project.compositions[0].layers[0].id;
    const begun = (await service.executeTool("begin_edit_workspace", {
      baseRevision: 7,
    })) as { workspaceId: string; workspaceRevision: number };
    const executed = (await service.executeTool("execute_commands", {
      workspaceId: begun.workspaceId,
      workspaceRevision: begun.workspaceRevision,
      commands: [{ type: "renameLayer", layerId, name: "Agent result" }],
    })) as { workspaceRevision: number };
    await service.executeTool("analyze_render", {
      workspaceId: begun.workspaceId,
      workspaceRevision: executed.workspaceRevision,
      times: [0, 1],
    });
    await service.executeTool("submit_workspace", {
      workspaceId: begun.workspaceId,
      workspaceRevision: executed.workspaceRevision,
      summary: "Rename the title",
    });
    const submitted = service.submittedWorkspace();
    expect(submitted?.operations).toHaveLength(1);
    expect(submitted?.baseRevision).toBe(7);
    expect(submitted?.verification).toBe("metrics_only");
    expect(service.auditEvents().every((entry) => !("arguments" in entry))).toBe(true);
    await expect(
      service.executeTool("execute_commands", {
        workspaceId: begun.workspaceId,
        workspaceRevision: executed.workspaceRevision,
        commands: [{ type: "renameLayer", layerId, name: "Too late" }],
      }),
    ).rejects.toThrow("frozen");
  });

  it("discards all staged state on abort", async () => {
    const { service } = createService();
    await service.executeTool("begin_edit_workspace", { baseRevision: 7 });
    service.abort();
    await expect(service.executeTool("get_editor_context", {})).rejects.toThrow("aborted");
  });

  it("routes bounded staged previews to native vision only for image-capable models", async () => {
    for (const supportsImages of [true, false]) {
      const project = createBlankProject();
      const rendered: AgentRenderedPreviewFrame = {
        time: 0,
        renderId: "render-1",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
        width: 64,
        height: 64,
        measurements: {
          averageLuminance: 0.5,
          minimumLuminance: 0,
          maximumLuminance: 1,
          visiblePixelRatio: 1,
          emptyFrame: false,
        },
      };
      const service = new AsterAgentApplicationService({
        project,
        projectRevision: 7,
        selection: [],
        currentTime: 0,
        accessMode: "agent",
        primaryModelSupportsImages: supportsImages,
        renderPreview: async (stagedProject, times) => {
          expect(stagedProject).not.toBe(project);
          expect(times).toEqual([0]);
          return [rendered];
        },
      });
      const begun = (await service.executeTool("begin_edit_workspace", {
        baseRevision: 7,
      })) as { workspaceId: string; workspaceRevision: number };
      const preview = (await service.executeTool("render_preview", {
        workspaceId: begun.workspaceId,
        workspaceRevision: begun.workspaceRevision,
        times: [0],
      })) as { status: string };
      expect(preview.status).toBe("rendered");
      const analysis = (await service.executeTool("analyze_render", {
        workspaceId: begun.workspaceId,
        workspaceRevision: begun.workspaceRevision,
        times: [0],
      })) as { mode: string; verification: string };
      expect(analysis).toMatchObject(
        supportsImages
          ? { mode: "native_vision", verification: "verified_by_primary_model" }
          : { mode: "deterministic_metrics", verification: "metrics_only" },
      );
    }
  });
});
