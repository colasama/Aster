import { type TObject, type TSchema, Type } from "typebox";
import { contactSheetField } from "./contact-sheet-spec.js";
import { EDIT_LIMITS } from "./edit-limits.js";
import { previewFields } from "./preview-options.js";

export function asterToolDefinitions() {
  const revision = Type.Integer({ minimum: 0 });
  const workspaceFields = {
    workspaceId: Type.String({ minLength: 1 }),
    workspaceRevision: revision,
  };
  const wait = Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: EDIT_LIMITS.maxWaitMs,
      description: `Milliseconds to block until the execution settles (default ${EDIT_LIMITS.defaultWaitMs}; 0 returns immediately).`,
    }),
  );
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
        "Find Aster commands (and matching effect types) by intent words, e.g. 'delete composition', 'replace video source', 'per character text animation'. Synonyms and partial matches are ranked; an empty query or no match returns the full command index by category.",
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
      description:
        "Read a filtered, paginated, byte-bounded project view. kind 'compositions' lists every composition (including nested ones); layers/properties/effects/scene read the active composition or compositionId. query filters by name substring. Omit projectRevision to read the live project.",
      parameters: Type.Object(
        {
          projectRevision: Type.Optional(revision),
          workspaceId: Type.Optional(Type.String({ minLength: 1 })),
          compositionId: Type.Optional(Type.String({ minLength: 1 })),
          query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          kind: Type.Union([
            Type.Literal("project"),
            Type.Literal("compositions"),
            Type.Literal("layers"),
            Type.Literal("properties"),
            Type.Literal("effects"),
            Type.Literal("assets"),
            Type.Literal("fonts"),
            Type.Literal("markers"),
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
      name: "list_effects",
      label: "List effects",
      description:
        "List registered effect types with parameter keys, defaults and ranges. Filter by query words (e.g. 'blur', 'glow') or category.",
      parameters: Type.Object(
        {
          query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          category: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })),
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
        "Atomically validate and execute 1 through 256 typed commands in a staged workspace.",
      parameters: Type.Object(
        {
          ...workspaceFields,
          commands: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
            minItems: 1,
            maxItems: EDIT_LIMITS.commandsPerBatch,
          }),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "get_workspace_status",
      label: "Workspace status",
      description:
        "Read the workspace revision, state, operation/byte budgets and idle expiry without extending its lifetime.",
      parameters: Type.Object(
        { workspaceId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    },
    {
      name: "get_script_api",
      label: "Script API",
      description:
        "Read the script API cheat sheet once before scripting: methods, property paths, expression functions, text animators, time-mapping formula, color convention, budgets and common errors.",
      parameters: Type.Object({}, { additionalProperties: false }),
    },
    {
      name: "execute_aster_code",
      label: "Execute Aster code",
      description:
        "Run a synchronous JavaScript function body against a staged workspace (bulk edits in one call). Provide workspaceId + workspaceRevision, or baseRevision to create a workspace. Waits for completion by default and returns state, workspaceRevision, result and warnings; only a still-running result needs get_execution. Failure rolls back this execution only.",
      parameters: Type.Object(
        {
          workspaceId: Type.Optional(workspaceFields.workspaceId),
          workspaceRevision: Type.Optional(revision),
          baseRevision: Type.Optional(revision),
          code: Type.String({ minLength: 1, maxLength: EDIT_LIMITS.scriptBytes }),
          wait,
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "get_execution",
      label: "get_execution",
      description:
        "Wait for (default up to 45 s) and read execution status, result, warnings and progress. Use the successful workspaceRevision for subsequent edits.",
      parameters: Type.Object(
        { executionId: Type.String({ minLength: 1 }), wait },
        { additionalProperties: false },
      ),
    },
    {
      name: "cancel_execution",
      label: "cancel_execution",
      description:
        "Terminate a script and discard its uncommitted execution; preserve previous workspace edits.",
      parameters: Type.Object(
        { executionId: Type.String({ minLength: 1 }) },
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
        "Render deterministic preview samples of the staged workspace (video decoded to the exact frame) with per-frame metrics. Pass times (1-12 separate images) or contactSheet to tile up to 64 labeled samples into one image, e.g. {start:0,end:60,interval:5}.",
      parameters: Type.Object(
        {
          ...workspaceFields,
          ...previewFields,
          times: Type.Optional(
            Type.Array(Type.Number({ minimum: 0, maximum: 86_400 }), {
              minItems: 1,
              maxItems: 12,
            }),
          ),
          contactSheet: contactSheetField,
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
        "Freeze the cumulative staged result for approval or commit. Returns a compact summary (operation counts by type); verbose returns every operation type and changed ID.",
      parameters: Type.Object(
        {
          ...workspaceFields,
          summary: Type.String({ minLength: 1, maxLength: 500 }),
          verbose: Type.Optional(Type.Boolean()),
        },
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
  return definitions.map((definition) => {
    if (
      ![
        "begin_edit_workspace",
        "execute_commands",
        "execute_aster_code",
        "submit_workspace",
        "discard_workspace",
      ].includes(definition.name)
    )
      return definition;
    return {
      ...definition,
      parameters: Type.Object(
        {
          ...(definition.parameters as TObject).properties,
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$" }),
          ),
        },
        { additionalProperties: false },
      ),
    };
  });
}
