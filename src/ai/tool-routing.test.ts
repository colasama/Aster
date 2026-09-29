import { describe, expect, it } from "vitest";
import { automationToolDefinitions } from "./automation-protocol";
import { asterToolDefinitions } from "./tool-definitions";
import { routeToolCall } from "./tool-routing";

describe("consolidated tool routing", () => {
  it("maps topics, actions and options onto internal operations", () => {
    expect(routeToolCall("describe", { topic: "script" })).toEqual({
      name: "get_script_api",
      arguments: {},
    });
    expect(routeToolCall("describe", { topic: "commands", query: "delete comp" })).toEqual({
      name: "search_capabilities",
      arguments: { query: "delete comp" },
    });
    expect(routeToolCall("describe", { topic: "commands", names: ["addLayer"] }).name).toBe(
      "get_command_schemas",
    );
    expect(routeToolCall("describe", { topic: "effects", query: "blur" })).toEqual({
      name: "list_effects",
      arguments: { query: "blur" },
    });
    expect(routeToolCall("render", { action: "wait", jobId: "j", timeoutMs: 5 })).toEqual({
      name: "wait_render",
      arguments: { jobId: "j", timeoutMs: 5 },
    });
    expect(routeToolCall("script_modules", { action: "remove", name: "lib" })).toEqual({
      name: "put_script_module",
      arguments: { name: "lib", remove: true },
    });
    expect(routeToolCall("get_execution", { executionId: "e", cancel: true }).name).toBe(
      "cancel_execution",
    );
    expect(routeToolCall("get_editor_context", { reset: true }).name).toBe("reset_session");
    expect(routeToolCall("query_project", { kind: "workspace", workspaceId: "w" })).toEqual({
      name: "get_workspace_status",
      arguments: { workspaceId: "w" },
    });
    expect(
      routeToolCall("execute_aster_code", { baseRevision: 0, commands: [{ type: "x" }], wait: 5 }),
    ).toEqual({
      name: "execute_commands",
      arguments: { baseRevision: 0, commands: [{ type: "x" }] },
    });
    expect(routeToolCall("import_assets", { path: "a.png", baseRevision: 1 }).arguments).toEqual({
      baseRevision: 1,
      paths: ["a.png"],
    });
  });

  it("explains missing actions and fields", () => {
    expect(() => routeToolCall("render", {})).toThrow("export | status | wait | cancel");
    expect(() => routeToolCall("render", { action: "export", path: "x" })).toThrow(
      "requires baseRevision, outputKind",
    );
    expect(() => routeToolCall("execute_aster_code", { baseRevision: 0 })).toThrow(
      "exactly one of code or commands",
    );
  });

  it("advertises a compact surface to agents", () => {
    expect(asterToolDefinitions().map(({ name }) => name)).toHaveLength(9);
    expect(automationToolDefinitions().length).toBeLessThanOrEqual(20);
  });
});
