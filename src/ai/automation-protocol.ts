import { Type } from "typebox";
import { previewFields } from "./preview-options.js";
import { asterToolDefinitions } from "./tool-definitions.js";

const path = Type.String({ minLength: 1, maxLength: 4096 });
const time = Type.Number({ minimum: 0, maximum: 86_400 });
const revision = Type.Integer({ minimum: 0 });
const workspace = { workspaceId: Type.String({ minLength: 1 }), workspaceRevision: revision };
const times = Type.Array(time, { minItems: 1, maxItems: 12 });

export function automationToolDefinitions() {
  const extra = [
    [
      "probe_reference",
      "Read local reference media metadata, streams, dimensions, frame rate and duration.",
      { path },
    ],
    [
      "read_reference_frames",
      "Decode the first video frame at or after each requested time. Returns PNG images and actual timestamps.",
      { path, times, maxDimension: previewFields.maxDimension },
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
      "Import an image, video, audio, SVG, PSD or embedded glTF/GLB into the active composition as one undoable edit.",
      { path, baseRevision: revision, time: Type.Optional(time) },
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
      "Capture the current project and enqueue an immutable render job. Destination must not already exist; returns job ID and queue state.",
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
    ["get_render_queue", "Read render progress, completion, output paths and errors.", {}],
    [
      "cancel_render",
      "Cancel a queued or running render job.",
      { jobId: Type.String({ minLength: 1 }) },
    ],
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
          Type.Tuple([
            Type.Integer({ minimum: 100, maximum: 900 }),
            Type.Integer({ minimum: 100, maximum: 900 }),
          ]),
        ),
      },
    ],
    [
      "commit_workspace",
      "Apply a submitted workspace to the unchanged live project as one undoable transaction.",
      workspace,
    ],
    [
      "reset_session",
      "Discard external edit workspaces and capture the current live project for a new editing session.",
      {},
    ],
  ] as const;
  return [
    ...asterToolDefinitions(),
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
  onCancel(listener: (clientId: string) => void): () => void;
  respond(response: { requestId: string; result?: unknown; error?: string }): Promise<void>;
}
