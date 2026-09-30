import { type TObject, type TProperties, Type } from "typebox";
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
const action = (...values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const optional = (fields: TProperties) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [key, Type.Optional(schema)]),
  ) as TProperties;
export const MAX_IMPORT_BATCH = 32;
export const MAX_RENDER_WAIT_MS = 100_000;

/** External-only tools layered over the shared editing tools. */
export function automationToolDefinitions() {
  const extra: Array<[string, string, TProperties]> = [
    [
      "commit_workspace",
      "Apply a workspace to the unchanged live project as one undoable transaction. An unsubmitted workspace is submitted first (summary optional).",
      { ...workspace, summary, requestId },
    ],
    [
      "import_assets",
      `Import 1 through ${MAX_IMPORT_BATCH} images, videos, audio, SVG, PSD or glTF/GLB files (paths, or one path) into the active composition, one undo step each. Returns per-file layerIds/warnings/errors and the final projectRevision. hidden adds switched-off layers; audioEnabled:false silences video layers.`,
      {
        paths: Type.Optional(Type.Array(path, { minItems: 1, maxItems: MAX_IMPORT_BATCH })),
        path: Type.Optional(path),
        baseRevision: revision,
        time: Type.Optional(time),
        hidden: Type.Optional(Type.Boolean()),
        audioEnabled: Type.Optional(Type.Boolean()),
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
      "Save the current project and collect its media into a local bundle directory. Omit path to save back to the project's current location. Refuses to overwrite another existing project unless overwrite is true.",
      {
        path: Type.Optional(path),
        baseRevision: revision,
        overwrite: Type.Optional(Type.Boolean()),
      },
    ],
    [
      "render",
      `Export and track renders. action 'export' (path, baseRevision, outputKind mp4|pngSequence|still, optional compositionId, range composition|workArea|currentFrame, time, includeAudio) enqueues an immutable job and returns only that job; 'wait' (jobId, timeoutMs up to ${MAX_RENDER_WAIT_MS}) blocks until it settles and reports MP4 black segments (limited-range aware) or still luminance (analyze:false skips); 'status' lists compact jobs newest first (or one jobId); 'cancel' stops a job.`,
      {
        action: action("export", "wait", "status", "cancel"),
        ...optional({
          jobId,
          path,
          baseRevision: revision,
          compositionId: Type.String(),
          outputKind: action("mp4", "pngSequence", "still"),
          range: action("composition", "workArea", "currentFrame"),
          time,
          includeAudio: Type.Boolean(),
          timeoutMs: Type.Integer({ minimum: 0, maximum: MAX_RENDER_WAIT_MS }),
          analyze: Type.Boolean(),
          limit: Type.Integer({ minimum: 1, maximum: 64 }),
        }),
      },
    ],
    [
      "reference",
      "Study local reference media with FFmpeg. action 'probe' returns streams, size, frame rate and duration; 'frames' returns the first frame at or after each time (actual timestamps), or one labeled contactSheet of up to 64 samples (e.g. {interval:5}); 'audio' returns up to 30 s of mono 16 kHz WAV (start, duration); 'compare' renders the staged workspace at matched times and returns side-by-side, overlay and difference images (offset maps composition to reference time).",
      {
        action: action("probe", "frames", "audio", "compare"),
        path,
        ...optional({
          times,
          maxDimension: Type.Integer({ minimum: 64, maximum: 2048 }),
          contactSheet: contactSheetField,
          start: time,
          duration: Type.Number({ exclusiveMinimum: 0, maximum: 30 }),
          ...workspace,
          offset: Type.Number({ minimum: -86_400, maximum: 86_400 }),
          crop: previewFields.crop,
          layerIds: previewFields.layerIds,
        }),
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
      "fonts",
      "Fonts for text layers. action 'list' lists system faces and project fonts (source all|system|project, query, offset, limit); 'check' confirms exact family names render (families); 'import' embeds a local TTF/OTF/WOFF/WOFF2 into the project as one undoable edit (path, baseRevision, family alias, weight or variable weightRange; 8 MiB project budget, no OS install).",
      {
        action: action("list", "check", "import"),
        ...optional({
          source: action("all", "system", "project"),
          query: Type.String({ maxLength: 160 }),
          offset: Type.Integer({ minimum: 0 }),
          limit: Type.Integer({ minimum: 1, maximum: 128 }),
          families: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
            minItems: 1,
            maxItems: 64,
          }),
          path,
          baseRevision: revision,
          family: Type.String({ minLength: 1, maxLength: 160 }),
          weight: Type.Integer({ minimum: 100, maximum: 900 }),
          weightRange: Type.Array(Type.Integer({ minimum: 100, maximum: 900 }), {
            minItems: 2,
            maxItems: 2,
          }),
        }),
      },
    ],
    [
      "script_modules",
      `Store helper libraries once for aster.require(name) in later scripts. action 'put' (name, code) stores a module whose body receives module, exports and aster; 'remove' (name) deletes it; 'list' shows names and sizes. Modules belong to this connection, survive commits and are cleared by get_editor_context reset or disconnect (${EDIT_LIMITS.scriptModules} modules, ${EDIT_LIMITS.scriptModuleBytes / 1024} KiB total).`,
      {
        action: action("put", "remove", "list"),
        name: Type.Optional(moduleName),
        code: Type.Optional(Type.String({ minLength: 1, maxLength: EDIT_LIMITS.scriptBytes })),
      },
    ],
  ];
  return [
    ...asterToolDefinitions().map((definition) => {
      const extend = (description: string, fields: TProperties) => ({
        ...definition,
        description: `${definition.description} ${description}`,
        parameters: Type.Object(
          { ...(definition.parameters as TObject).properties, ...fields },
          { additionalProperties: false },
        ),
      });
      if (definition.name === "execute_aster_code")
        return extend(
          "commit:true then submits and commits on success (one undo step) and returns projectRevision.",
          { commit: Type.Optional(Type.Boolean()), summary },
        );
      if (definition.name === "get_editor_context")
        return extend(
          "reset:true discards this client's staged workspaces and script modules and captures the live project again (use after external user edits).",
          { reset: Type.Optional(Type.Boolean()) },
        );
      return definition;
    }),
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
