import { type TObject, Type } from "typebox";
import { contactSheetField } from "./contact-sheet-spec.js";
import { EDIT_LIMITS } from "./edit-limits.js";
import { previewFields } from "./preview-options.js";
import { asterToolDefinitions } from "./tool-definitions.js";

const path = Type.String({ minLength: 1, maxLength: 4096 });
const time = Type.Number({ minimum: 0, maximum: 86_400 });
const revision = Type.Integer({ minimum: 0 });
const workspace = { workspaceId: Type.String({ minLength: 1 }), workspaceRevision: revision };
const times = Type.Array(time, { minItems: 1, maxItems: 12 });
const requestId = Type.Optional(
  Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$" }),
);
const summary = Type.Optional(Type.String({ minLength: 1, maxLength: 500 }));
const moduleName = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" });
const jobId = Type.String({ minLength: 1 });
export const MAX_IMPORT_BATCH = 32;
export const MAX_RENDER_WAIT_MS = 100_000;

export function automationToolDefinitions() {
  const extra = [
    [
      "probe_reference",
      "Read local reference media metadata, streams, dimensions, frame rate and duration.",
      { path },
    ],
    [
      "read_reference_frames",
      "Decode the first video frame at or after each requested time. Returns PNG images and actual timestamps. contactSheet tiles up to 64 labeled samples (e.g. {interval:5} over the whole file) into one image instead.",
      {
        path,
        times: Type.Optional(times),
        maxDimension: previewFields.maxDimension,
        contactSheet: contactSheetField,
      },
    ],
    [
      "read_reference_audio",
      "Read up to 30 seconds of mono 16 kHz WAV audio from a local reference.",
      { path, start: time, duration: Type.Number({ exclusiveMinimum: 0, maximum: 30 }) },
    ],
    [
      "compare_reference",
      "Compare staged renders with a reference at matched times. Returns side-by-side, overlay and difference images; crop uses normalized coordinates on both images.",
      {
        ...workspace,
        path,
        times,
        offset: Type.Optional(Type.Number({ minimum: -86_400, maximum: 86_400 })),
        ...previewFields,
      },
    ],
    [
      "import_asset",
      "Import an image, video, audio, SVG, PSD or embedded glTF/GLB into the active composition as one undoable edit. hidden adds the layers switched off; audioEnabled:false silences imported video layers.",
      {
        path,
        baseRevision: revision,
        time: Type.Optional(time),
        hidden: Type.Optional(Type.Boolean()),
        audioEnabled: Type.Optional(Type.Boolean()),
      },
    ],
    [
      "import_assets",
      `Import 1 through ${MAX_IMPORT_BATCH} media files in order (one undo step each) in a single call. Returns per-file layerIds/warnings/errors and the final projectRevision. Options match import_asset.`,
      {
        paths: Type.Array(path, { minItems: 1, maxItems: MAX_IMPORT_BATCH }),
        baseRevision: revision,
        time: Type.Optional(time),
        hidden: Type.Optional(Type.Boolean()),
        audioEnabled: Type.Optional(Type.Boolean()),
      },
    ],
    [
      "analyze_beats",
      "Analyze tempo (BPM), beat grid, downbeats and song sections of project audio (layerId maps times onto the composition; sourceId gives source time) or a local file (path). Returns expression snippets such as pow(1 - beatphase(bpm, offset), 3) for beat-synced motion. writeMarkers:true (with baseRevision) writes beat/downbeat/section markers into the composition, keeping custom markers.",
      {
        layerId: Type.Optional(Type.String({ minLength: 1 })),
        sourceId: Type.Optional(Type.String({ minLength: 1 })),
        path: Type.Optional(path),
        compositionId: Type.Optional(Type.String({ minLength: 1 })),
        writeMarkers: Type.Optional(Type.Boolean()),
        baseRevision: Type.Optional(revision),
        beatsPerBar: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
        minBpm: Type.Optional(Type.Number({ minimum: 20, maximum: 400 })),
        maxBpm: Type.Optional(Type.Number({ minimum: 20, maximum: 400 })),
      },
    ],
    [
      "relink_source",
      "Replace a still, video or audio source with another local file of the same kind (for example a higher-resolution render), retargeting every layer in every composition as one undoable edit. The old source is removed unless removeOld is false. Returns the new sourceId.",
      {
        sourceId: Type.String({ minLength: 1 }),
        path,
        baseRevision: revision,
        removeOld: Type.Optional(Type.Boolean()),
      },
    ],
    [
      "open_project",
      "Open a native project bundle directory at the current live revision, including its media and fonts. Save unsaved edits first. Invalidates all staged workspaces; no file dialog is shown.",
      { path, baseRevision: revision },
    ],
    [
      "save_project",
      "Save the current project and collect its media into the exact local directory. Refuses to overwrite another existing project unless overwrite is true.",
      { path, baseRevision: revision, overwrite: Type.Optional(Type.Boolean()) },
    ],
    [
      "export_render",
      "Capture the current project and enqueue an immutable render job. Destination must not already exist. Returns the new job only; follow with wait_render.",
      {
        path,
        baseRevision: revision,
        compositionId: Type.Optional(Type.String()),
        outputKind: Type.Union([
          Type.Literal("mp4"),
          Type.Literal("pngSequence"),
          Type.Literal("still"),
        ]),
        range: Type.Optional(
          Type.Union([
            Type.Literal("composition"),
            Type.Literal("workArea"),
            Type.Literal("currentFrame"),
          ]),
        ),
        time: Type.Optional(time),
        includeAudio: Type.Optional(Type.Boolean()),
      },
    ],
    [
      "get_render_queue",
      "Read compact render job status (progress, output paths, errors), newest first. jobId returns one job.",
      {
        jobId: Type.Optional(jobId),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
      },
    ],
    [
      "wait_render",
      `Block until a render job completes, fails or is cancelled, or until timeoutMs (default and maximum ${MAX_RENDER_WAIT_MS}). Returns the job with output paths; call again if it is still running.`,
      {
        jobId,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_RENDER_WAIT_MS })),
      },
    ],
    ["cancel_render", "Cancel a queued or running render job.", { jobId }],
    [
      "check_fonts",
      "Check availability of exact font-family names in the renderer. Does not install fonts.",
      {
        families: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
          minItems: 1,
          maxItems: 64,
        }),
      },
    ],
    [
      "list_fonts",
      "List installed system faces and project font metadata, with filtering and pagination. No font bytes are returned.",
      {
        source: Type.Optional(
          Type.Union([Type.Literal("all"), Type.Literal("system"), Type.Literal("project")]),
        ),
        query: Type.Optional(Type.String({ maxLength: 160 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
      },
    ],
    [
      "import_font",
      "Embed a local TTF, OTF, WOFF or WOFF2 face into the project as one undoable edit. Supply its family alias and default weight, plus weightRange [minimum, maximum] for variable fonts. Project fonts have an 8 MiB total budget. Does not install into the operating system.",
      {
        path,
        baseRevision: revision,
        family: Type.String({ minLength: 1, maxLength: 160 }),
        weight: Type.Optional(Type.Integer({ minimum: 100, maximum: 900 })),
        weightRange: Type.Optional(
          Type.Array(Type.Integer({ minimum: 100, maximum: 900 }), {
            minItems: 2,
            maxItems: 2,
          }),
        ),
      },
    ],
    [
      "commit_workspace",
      "Apply a workspace to the unchanged live project as one undoable transaction. An unsubmitted workspace is submitted first (summary optional).",
      { ...workspace, summary, requestId },
    ],
    [
      "put_script_module",
      `Store (or with remove:true delete) a JavaScript module for aster.require(name) in later scripts, so shared helper libraries are sent once. Modules belong to this MCP connection, survive commits and are cleared on reset_session or disconnect (${EDIT_LIMITS.scriptModules} modules, ${EDIT_LIMITS.scriptModuleBytes / 1024} KiB total). The body receives module, exports and aster; assign module.exports or return a value.`,
      {
        name: moduleName,
        code: Type.Optional(Type.String({ minLength: 1, maxLength: EDIT_LIMITS.scriptBytes })),
        remove: Type.Optional(Type.Boolean()),
      },
    ],
    ["list_script_modules", "List stored script module names and sizes.", {}],
    [
      "reset_session",
      "Discard external edit workspaces and capture the current live project for a new editing session.",
      {},
    ],
  ] as const;
  return [
    ...asterToolDefinitions().map((definition) =>
      definition.name === "execute_aster_code"
        ? {
            ...definition,
            description: `${definition.description} commit:true then submits and commits on success (one undo step) and returns projectRevision.`,
            parameters: Type.Object(
              {
                ...(definition.parameters as TObject).properties,
                commit: Type.Optional(Type.Boolean()),
                summary,
              },
              { additionalProperties: false },
            ),
          }
        : definition,
    ),
    ...extra.map(([name, description, fields]) => ({
      name,
      label: name,
      description,
      parameters: Type.Object(fields, { additionalProperties: false }),
    })),
  ];
}

export interface AutomationRequest {
  requestId: string;
  clientId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AutomationDesktopApi {
  onRequest(listener: (request: AutomationRequest) => void): () => void;
  onCancel(listener: (clientId: string, discard?: boolean) => void): () => void;
  respond(response: {
    requestId: string;
    result?: unknown;
    error?: string;
    errorDetails?: { code: string; message: string; details: Record<string, unknown> };
  }): Promise<void>;
}
