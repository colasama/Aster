import { type TSchema, Type } from "typebox";
import { previewFields } from "./preview-options.js";

export function asterToolDefinitions() {
  const revision = Type.Integer({ minimum: 0 });
  const workspaceFields = {
    workspaceId: Type.String({ minLength: 1 }),
    workspaceRevision: revision,
  };
  const definitions: Array<{
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
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
            Type.Literal("fonts"),
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
          ...previewFields,
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
  return definitions;
}
