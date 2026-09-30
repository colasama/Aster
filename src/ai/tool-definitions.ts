import { type TObject, type TSchema, Type } from "typebox";
import { contactSheetField } from "./contact-sheet-spec.js";
import { EDIT_LIMITS } from "./edit-limits.js";
import { previewFields } from "./preview-options.js";

export interface AsterToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
}

export const REQUEST_ID_TOOLS = ["execute_aster_code", "submit_workspace", "discard_workspace"];

/**
 * Public editing tools shared by the built-in agent and external automation. Each concern is one
 * tool; tool-routing.ts maps topics, actions and options onto internal operations.
 */
export function asterToolDefinitions(): AsterToolDefinition[] {
  const revision = Type.Integer({ minimum: 0 });
  const workspaceFields = {
    workspaceId: Type.String({ minLength: 1 }),
    workspaceRevision: revision,
  };
  const time = Type.Number({ minimum: 0, maximum: 86_400 });
  const times = Type.Array(time, { minItems: 1, maxItems: 12 });
  const wait = Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: EDIT_LIMITS.maxWaitMs,
      description: `Milliseconds to block until the execution settles (default ${EDIT_LIMITS.defaultWaitMs}; 0 returns immediately).`,
    }),
  );
  const definitions: AsterToolDefinition[] = [
    {
      name: "get_editor_context",
      label: "Get editor context",
      description:
        "Read the live project revision, active composition, selection, access mode, and capability categories.",
      parameters: Type.Object({}, { additionalProperties: false }),
    },
    {
      name: "describe",
      label: "Describe capabilities",
      description:
        "Discover what Aster can do. topic 'script' returns the script API cheat sheet (methods, property paths, expression functions, text animators, time mapping, colors, budgets, common errors) - read it once before scripting. topic 'commands' ranks typed commands by intent words (synonyms work; no query lists every command by category), or returns exact input schemas for names. topic 'effects' lists effect types with parameter keys, defaults and ranges.",
      parameters: Type.Object(
        {
          topic: Type.Union([
            Type.Literal("script"),
            Type.Literal("commands"),
            Type.Literal("effects"),
          ]),
          query: Type.Optional(Type.String({ maxLength: 500 })),
          names: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }),
          ),
          category: Type.Optional(Type.String({ maxLength: 100 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "query_project",
      label: "Query project",
      description:
        "Read a filtered, paginated, byte-bounded project view. kind 'compositions' lists every composition (including nested ones); layers/properties/effects/markers/scene read the active composition or compositionId; query filters by name; 'workspace' returns a workspace's revision, state, budgets and expiry. Omit projectRevision to read the live project.",
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
            Type.Literal("workspace"),
          ]),
          time: Type.Optional(Type.Number({ minimum: 0 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "execute_aster_code",
      label: "Execute Aster code",
      description:
        "Edit a staged workspace in one call: code runs a synchronous JavaScript function body with the aster API (bulk edits, loops, helpers); commands applies 1-256 typed commands atomically. Pass baseRevision (live revision) to start a workspace, or workspaceId + workspaceRevision to continue one. Waits for completion by default and returns state, workspaceRevision, result and warnings. Failure rolls back this execution only.",
      parameters: Type.Object(
        {
          workspaceId: Type.Optional(workspaceFields.workspaceId),
          workspaceRevision: Type.Optional(revision),
          baseRevision: Type.Optional(revision),
          code: Type.Optional(Type.String({ minLength: 1, maxLength: EDIT_LIMITS.scriptBytes })),
          commands: Type.Optional(
            Type.Array(Type.Record(Type.String(), Type.Unknown()), {
              minItems: 1,
              maxItems: EDIT_LIMITS.commandsPerBatch,
            }),
          ),
          wait,
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "get_execution",
      label: "Get execution",
      description:
        "Wait for (default up to 45 s) and read a script's status, result, warnings and progress; cancel:true terminates it and discards only its uncommitted changes.",
      parameters: Type.Object(
        {
          executionId: Type.String({ minLength: 1 }),
          wait,
          cancel: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "render_preview",
      label: "Render preview",
      description:
        "Render deterministic preview samples of the staged workspace (video decoded to the exact frame) with per-frame metrics and black-frame warnings. Pass times (1-12 separate images) or contactSheet to tile up to 64 labeled samples into one image, e.g. {start:0,end:60,interval:5}.",
      parameters: Type.Object(
        {
          ...workspaceFields,
          ...previewFields,
          times: Type.Optional(times),
          contactSheet: contactSheetField,
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "diagnostics",
      label: "Diagnostics",
      description:
        "Objective checks. action 'inspect' lists unresolved assets and invalid timing (live project or workspaceId); 'analyze' measures sampled frames of a workspace; 'evaluate' returns evaluated properties and scene state at one time.",
      parameters: Type.Object(
        {
          action: Type.Union([
            Type.Literal("inspect"),
            Type.Literal("analyze"),
            Type.Literal("evaluate"),
          ]),
          workspaceId: Type.Optional(Type.String({ minLength: 1 })),
          workspaceRevision: Type.Optional(revision),
          times: Type.Optional(times),
          time: Type.Optional(time),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: "submit_workspace",
      label: "Submit workspace",
      description:
        "Freeze the staged result for approval or commit. Returns a compact summary (operation counts by type); verbose returns every operation type and changed ID.",
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
  return definitions.map((definition) =>
    REQUEST_ID_TOOLS.includes(definition.name)
      ? {
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
        }
      : definition,
  );
}
