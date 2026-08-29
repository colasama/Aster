# Pi agent integration design

Status: the initial Pi desktop integration is implemented. The version-1 command registry covers all
49 variants in the live TypeScript editor `Operation` union. The isolated Pi utility process, bounded
Aster meta-tools, staged workspaces, Review/Agent grants, guarded Full Access, cancellation, real
bounded preview readback, native image routing, deterministic metrics fallback, plugin management,
project pack/unpack, and saved-project asset linking described below are live and tested. Native-core
project pack/unpack, and saved-project asset linking described below are live and tested. A broader
deterministic analyzer catalog, first-class agent render-export services, structured CLI/MCP adapters,
and bundled domain skills remain explicitly later rollout work rather than requirements of this
initial desktop integration.

## Decision summary

Aster will use Pi as the agent runtime and Aster's typed application services as the primary
interaction surface. The agent may eventually operate every project feature, but normal editing must
not depend on direct project-file mutation, UI automation, or parsing human-oriented CLI output.

The target design has five central decisions:

1. A versioned command registry is the single source of truth for every editable Aster capability.
2. Pi discovers and invokes a small set of Aster meta-tools instead of receiving hundreds of static
   tool definitions at once.
3. Multi-step agent work occurs in an isolated edit workspace and is merged into the live project as
   one auditable undo transaction.
4. Review, Agent, and Full Access modes share the same correctness checks but grant different
   authority. Full Access removes per-action approval and enables system tools after an explicit
   native warning.
5. Visual verification supports either the primary model's native image input or deterministic
   analysis plus human review. A companion vision model is outside the initial scope.

## Goals

- Give the agent semantic access to every current and future project-editing feature.
- Preserve deterministic project evaluation, validation, undo, audit, and atomic persistence.
- Support multi-turn query, edit, evaluate, render, diagnose, and revise loops.
- Scale to large projects without injecting the complete project into every model request.
- Support models with and without image input.
- Offer an explicitly dangerous Full Access mode without confusing authorization with correctness.
- Keep the agent runtime replaceable and the Aster command protocol provider-independent.

## Non-goals

- Making raw JSON edits the normal project-editing path.
- Driving the editor by simulated mouse and keyboard input.
- Encoding operation schemas or security policy in skills.
- Automatically trusting user-global Pi extensions, skills, or packages.
- Providing a companion vision model in the first implementation.
- Elevating the agent beyond the operating-system permissions of the Aster process.

## Implemented baseline

The desktop AI panel now hosts a persistent Pi session through an isolated Electron utility process:

1. The renderer creates a revision-addressed `AsterAgentApplicationService` over a cloned project.
2. Electron starts or resumes a Pi session with only Aster's twelve meta-tools; default coding,
   filesystem, and shell tools are absent.
3. Tool requests cross a bounded IPC broker back to the renderer application service. All 49 live
   editor operations are discovered on demand from `schemas/ai-commands.v1.json`, structurally and
   semantically validated, and executed atomically in an isolated workspace.
4. Pi may query, edit, evaluate at explicit times, inspect diagnostics, and render bounded staged
   project previews before freezing one submitted workspace. Trusted image-capability metadata routes
   PNGs to Pi image content; text-only models receive only deterministic pixel metrics.
5. Review and Agent mode submissions remain previews. An accepted workspace merges as one frontend
   transaction with one undo entry and a secret-free command-log entry. A stale live revision blocks
   the merge.
6. Full Access requires typed confirmation plus a separate native warning. Its grant is scoped to
   renderer, project, model, provider, and expiry; revocation or emergency stop cancels model, tool,
   network, and child-process work.
7. Browser mode and provider failures retain the small deterministic local planner fallback.

The JSON registry is the authority for TypeScript discovery and validation, fully expanded Pi
schemas, parity tests, and the operation table in `AI_OPERATIONS.md`. Reusable `$defs` keep complex
particle, cloner, shape-graph, keyframe, mask, and LUT schemas cohesive. Compile-time and runtime
parity checks fail when the live TypeScript operation union and registry diverge. The TypeScript
application service and operation model are the sole authoritative AI command executor.

## Target architecture

```text
React AI panel
  |  prompts, streamed events, workspace diff, approval, emergency stop
  v
Electron agent host (prefer an isolated Node utility process)
  |  Pi SDK session with an Aster-owned resource loader and tool allowlist
  v
Aster agent tool adapter
  |  versioned request envelopes, grants, project revisions, cancellation
  v
Aster application services
  +-- capability and schema registry
  +-- project query service
  +-- edit workspace manager
  +-- command validation and execution
  +-- evaluation and render probes
  +-- asset, plugin, export, file, process, and network services
  +-- audit and diagnostics
  v
Canonical project state, renderer, persistence, and undo history
```

The Pi SDK is preferred because the desktop host is TypeScript and needs direct event streaming,
custom tools, session control, and model capability metadata. A Pi JSONL RPC subprocess remains a
valid packaging or isolation alternative. The transport choice must not change the Aster tool
contract.

The agent host must use an Aster-owned resource loader. Normal product sessions do not auto-discover
global or project-local Pi extensions. Trusted bundled skills may be enabled explicitly; executable
extensions or packages require Aster's own trust and installation flow.

## Canonical command registry

Every semantic mutation available to UI code, plugins, automation, or AI must be represented by a
versioned command descriptor. New features are not complete until their command is registered.

```ts
interface CommandDescriptor {
  name: string;
  version: number;
  category: string;
  description: string;
  inputSchema: JsonSchema;
  requiredPermissions: string[];
  risk: "reversible" | "external" | "destructive";
  undoable: boolean;
  previewable: boolean;
  availableIn: (context: CapabilityContext) => boolean;
}
```

The registry must cover at least:

- compositions, work areas, environments, and precomposition;
- layers, ordering, parenting, timing, time mapping, blending, and visibility;
- transforms, expressions, keyframes, interpolation, and easing;
- text content, typography, paths, shape graphs, and text animation;
- cameras, lights, materials, meshes, 3D settings, and environments;
- effects, masks, effect ordering, parameters, LUTs, and parameter animation;
- particles, cloners, media, audio, and imported assets;
- project metadata, plugin-owned capabilities, render settings, and export jobs.

The protocol has one source schema. TypeScript, Pi tool schemas, audit replay, tests, and
documentation consume the same versioned definition. The renderer-owned TypeScript application
service is the authoritative runtime; the native bridge provides privileged application services but
does not plan or execute AI operation batches.

Correctness rules belong to the command executor, not to Pi prompts or skills. They include finite
numbers, bounded collections, valid IDs, ownership, reference integrity, cycle rejection, render
limits, plugin availability, and project revision checks.

## Agent tool surface

Pi should receive a small stable set of meta-tools:

| Tool | Purpose |
| --- | --- |
| `get_editor_context` | Return project revision, active composition, time, selection, access mode, and a compact capability summary. |
| `search_capabilities` | Find relevant commands and services by intent or category. |
| `get_command_schemas` | Return exact schemas for a bounded list of relevant commands. |
| `query_project` | Query compositions, layers, properties, keyframes, effects, assets, and dependencies with filters and pagination. |
| `begin_edit_workspace` | Create a staged project branch from a specific revision. |
| `execute_commands` | Validate and execute typed commands in the staged workspace. |
| `evaluate_at_time` | Return time-addressed semantic evaluation without depending on playback history. |
| `render_preview` | Render bounded preview frames or auxiliary buffers from the staged workspace. |
| `analyze_render` | Route previews to native model vision or deterministic analyzers. |
| `inspect_diagnostics` | Report project, render, plugin, asset, and performance problems. |
| `submit_workspace` | Freeze a staged result and send its cumulative diff to the UI. |
| `discard_workspace` | Destroy an abandoned staged result. |

Large catalogs must be discovered on demand. `search_capabilities` returns identifiers and concise
summaries; `get_command_schemas` returns only the selected schemas. This keeps prompts bounded while
still giving the agent access to every registered feature.

Every read result and mutation request carries a project revision. Commands targeting a stale live
revision must not be silently committed.

## Edit workspace lifecycle

An edit workspace isolates multi-turn agent changes from the live editor:

1. `begin_edit_workspace` captures `baseRevision` and creates a clone, persistent delta, or
   copy-on-write view.
2. The agent queries and executes commands against the workspace.
3. Each command batch is atomic inside the workspace and returns normalized commands, diagnostics,
   changed object IDs, and a new workspace revision.
4. The agent evaluates or renders selected times and may continue editing.
5. `submit_workspace` freezes the workspace and produces a semantic before/after diff, render probes,
   external side effects, and visual-verification state.
6. Review mode waits for explicit acceptance. Agent mode waits for final acceptance. Full Access may
   merge automatically.
7. A successful merge records one live undo transaction where all actions are undoable, plus a
   secret-free audit entry.

If the live project changed after `baseRevision`, the application service attempts a deterministic
replay only when every command declares that replay safe. Otherwise it rejects the merge and asks the
agent to re-query and re-plan. It never overwrites concurrent user edits silently.

Workspace state has explicit byte, command-count, render-time, and lifetime budgets. Aborting a
session cancels pending model calls and rendering, discards unsubmitted workspace state, and stops
agent-owned background jobs.

## Access modes

Authorization is evaluated by the application service even when the Pi process or prompt is
compromised.

| Mode | Project operations | External capabilities | Commit policy |
| --- | --- | --- | --- |
| Review | Staged, reversible commands | Disabled unless separately approved | Preview and approve each submitted workspace |
| Agent | All staged project commands | Individually granted | Agent iterates autonomously; user approves the final workspace |
| Full Access | All Aster and system tools available to the process | File, process, network, plugin, import, export, and raw project access | No per-action approval after activation |

### Full Access semantics

Full Access is intentionally dangerous. It grants the agent every capability explicitly shipped or
installed into Aster that the current operating-system user can exercise, including:

- creating, modifying, and deleting any project content;
- reading, writing, moving, or deleting accessible files;
- invoking CLI programs and starting child processes;
- making network requests and downloading resources;
- installing, updating, enabling, or disabling plugins;
- reading and writing raw project bundles;
- starting renders and exports, including overwriting destinations; and
- sending prompts, project context, assets, or preview frames to the configured provider.

It does not elevate the operating-system account or grant administrator privileges automatically.

The AI cannot activate, renew, or widen Full Access. A native dialog must show the active project,
model, provider, data-egress implications, irreversible operations, and the exact authority being
granted. The user confirms with an intentional action such as typing the project name or `FULL
ACCESS`.

The default grant is session-scoped and expires on application restart, project switch, explicit
revocation, or a configured timeout. While active, the UI displays a persistent high-visibility
indicator and an emergency stop action. Emergency stop revokes the grant, aborts model and tool
requests, and terminates agent-owned child processes.

Suggested warning text:

> Full Access allows the AI to modify or delete project content, read and write files, run programs,
> access the network, install plugins, overwrite exports, and send project data or preview images to
> the configured model provider without asking for each action. Some actions cannot be undone and may
> cause data loss, cost, or disclosure of private information.

Full Access changes authorization, not correctness. Schema validation, revision checks, reference
integrity, atomic project persistence, bounded protocol messages, cancellation, and audit remain
mandatory. Reversible semantic changes still use transactions. Raw file and process side effects
that cannot be undone are labeled as irreversible in the audit log.

Even in Full Access, the system prompt and tool descriptions prefer the safest semantic path:

```text
Aster commands > asset/plugin/export services > direct file operations > shell commands
```

## Visual observation without a companion model

The editing model and visual-observation contract remain decoupled, but the first implementation has
only three outcomes:

```text
Primary model supports image input
  -> render sampled frames and let the primary model inspect them

Primary model lacks image input
  -> deterministic semantic and pixel analysis

Subjective judgment still required
  -> mark the result for human review
```

Model image support comes from trusted provider/model capability metadata. The application never asks
the model to self-report its modality.

```ts
type VisualVerification =
  | "verified_by_primary_model"
  | "metrics_only"
  | "not_verified";

interface VisualObservation {
  mode: "native_vision" | "deterministic_metrics" | "human_required";
  frames: Array<{ time: number; renderId: string }>;
  findings: VisualFinding[];
  measurements: Record<string, unknown>;
  limitations: string[];
  confidence?: number;
}
```

For a vision-capable primary model, `render_preview` attaches preview images together with semantic
metadata and `analyze_render` records the resulting verification state. For a text-only model only
deterministic findings are exposed, such as:

- layer and text bounds, safe-area violations, clipping, overlap, and complete occlusion;
- empty, black, transparent, invalid, or unexpectedly unchanged frames;
- luminance, HDR clipping, gamut, contrast, alpha coverage, and palette statistics;
- missing assets, fonts, plugins, effects, and unresolved references;
- frame differences, flicker indicators, motion speed, acceleration, jerk, and timing anomalies;
- camera clipping, depth distribution, particle limits, GPU cost, and render diagnostics; and
- before/after pixel differences or reference-image similarity when a reference is available.

The implemented baseline performs bounded 384-pixel GPU/Canvas readback, PNG encoding, empty-frame,
alpha coverage, luminance range, consecutive-frame difference, unresolved-asset, and invalid-timing
checks. The remaining items in the list are the phase-5 analyzer rollout, not current claims.

Deterministic metrics can verify objective constraints but cannot claim that composition, taste,
emphasis, rhythm, or aesthetics are good. Appearance-sensitive work completed without model vision is
recorded as `metrics_only` or `not_verified` and the UI identifies the frames the user should inspect.

Review and Agent modes require final human inspection for unverified appearance-sensitive changes.
Full Access may commit them automatically when the user has enabled that behavior, but the audit and
result UI must continue to state that the result was not visually verified.

### Frame sampling

Preview analysis uses bounded, meaningful samples instead of sending a complete video. Candidate
times include:

- composition and work-area boundaries;
- keyframe times and small offsets around discontinuities;
- layer in/out points and visibility changes;
- camera cuts and effect enable/disable transitions;
- extrema in speed or parameter change;
- regular low-frequency samples; and
- times explicitly selected by the agent or user.

Sampling is deterministic for the same project revision, request, and budget. The result records all
sample times so the analysis can be reproduced.

## Files, CLI, and external protocols

Direct project-file editing is a Full Access escape hatch, recovery mechanism, or developer tool. It
is not the standard way to rename a layer, add an effect, or create animation because it bypasses live
selection, revisions, undo, validation, and asset ownership.

A future `asterctl` should expose machine-readable JSON or JSONL adapters over the same application
services. Human-readable CLI output is not an agent protocol. Headless automation, CI, conformance
tests, and external agents can use the CLI without creating a second mutation implementation.

Pi RPC controls the Pi session; it does not replace the Aster command API. MCP can be added later as
an external ecosystem adapter over the same tools and permission service. Neither protocol is needed
for the initial in-process TypeScript integration.

## Skills

Skills provide domain workflows, not capabilities or authority. Operation schemas, parameter ranges,
live catalogs, and permissions always come from tools.

The initial bundled set should remain small:

- motion design and easing;
- typography and text animation;
- GPU effects and compositing;
- 3D camera, lighting, and depth;
- particles and cloners; and
- performance and project diagnostics.

A project-specific brand or art-direction skill may be enabled explicitly. Skills and their helper
files are versioned with Aster or pass the same trust review as plugins. Full Access does not imply
automatic trust of every skill or extension found in a user's global Pi directories.

## Audit, privacy, and data egress

Every agent session records:

- session, workspace, grant, project, base revision, model, and provider IDs;
- tool name, normalized arguments or a redacted digest, start/end time, and result status;
- normalized command types and affected object IDs;
- external paths, hosts, processes, plugins, export destinations, and irreversible side effects;
- preview sample times and visual-verification state;
- submit, approve, reject, abort, revoke, merge, undo, and redo events.

API keys, authorization headers, environment secrets, complete provider responses, and unbounded media
payloads are never copied into the project command log. The UI distinguishes data already sent to a
provider from data that is only proposed for transmission.

Audit storage has explicit count and byte limits, redaction rules, and an export format. Project logs
retain reproducible semantic transactions only while they remain within the existing project-format
budgets; detailed session telemetry belongs in application data.

## Failure and cancellation behavior

- A provider failure never partially merges a workspace.
- A command batch rolls back within the workspace if any command fails.
- A renderer or analyzer failure produces an explicit unverified result rather than a false success.
- A stale revision blocks merge unless deterministic replay succeeds.
- Plugin, process, network, and export failures are isolated and recorded per tool call.
- Model cancellation propagates to tools, render jobs, network requests, and agent-owned processes.
- Desktop restart discards unsubmitted ephemeral workspaces or offers recovery only after validating a
  bounded, secret-free checkpoint.

## Performance requirements

- Project queries are filtered, paginated, byte-bounded, and revision-addressed.
- Catalog schemas are loaded on demand and cached by registry version.
- Project evaluation remains `evaluate(time)` and never requires replay from frame zero.
- Preview rendering reuses existing GPU resources and uses explicit resolution, frame-count, GPU-time,
  and readback budgets.
- Deterministic analyzers operate on sampled frames and bounded auxiliary data.
- Agent events do not run in React's frame-critical path.
- Audit payloads and workspace deltas have hard memory and persistence limits.

Latency, token use, query bytes, command validation time, render time, analyzer time, merge time, and
abort latency should be instrumented separately.

## Implementation sequence

### Phase 1: converge the contract

1. Define a versioned AI-safe command schema for the live operation union.
2. Move provider normalization out of `AiPanel.tsx` into a tested domain service.
3. Generate or validate TypeScript, Pi tool, replay, and documentation views from one source.
4. Add a parity test that fails when a user-visible mutation bypasses the command registry.

### Phase 2: application services and workspaces

1. Add capability discovery and bounded project queries.
2. Add revision-addressed edit workspaces and atomic command batches.
3. Add normalized semantic diffs, stale-revision handling, merge, discard, and cancellation.
4. Preserve one undo transaction and existing command-log budgets on merge.

### Phase 3: Pi runtime

1. Host the Pi SDK in an isolated Node utility process or equivalent supervised runtime.
2. Use an Aster-owned resource loader and disable default coding tools.
3. Register the bounded Aster meta-tools and stream events to the AI panel.
4. Store conversations outside project files unless the user explicitly exports them.

### Phase 4: access modes

1. Implement Review and Agent grants in the application service.
2. Add the native Full Access warning, typed confirmation, persistent indicator, expiry, revocation, and
   emergency stop.
3. Register filesystem, process, network, raw-project, plugin, and export tools only for an effective
   Full Access grant.
4. Add irreversible-side-effect audit and cancellation conformance tests.

### Phase 5: visual observation

1. Add model image-capability metadata and routing.
2. Add deterministic frame sampling and bounded render probes.
3. Implement layout, clipping, empty-frame, luminance, alpha, frame-difference, motion, dependency, and
   performance analyzers.
4. Expose verification state and limitations in workspace review and audit.
5. Require or recommend human inspection according to access mode and verification state.

### Phase 6: complete capability parity

1. Register the rest of the live TypeScript operations in coherent domain groups. (Implemented for
   all 49 current variants.)
2. Keep the TypeScript command executor authoritative and add generated adapters only when needed.
3. Add assets, plugins, renders, exports, and project settings.
4. Add structured CLI and, if required, MCP adapters over the same application services.
5. Add the small, trusted domain-skill set.

## Validation and acceptance criteria

The integration is not complete until automated tests prove:

- every user-visible project mutation maps to a registered typed command;
- Pi, TypeScript, replay, and documentation use the same schema version;
- invalid, unknown, out-of-scope, stale, or over-budget commands are rejected before live mutation;
- workspace command batches are atomic and merge as one undo transaction;
- concurrent user edits cannot be silently overwritten;
- access grants cannot be created, renewed, or widened by the AI;
- Full Access tools are unavailable before activation and immediately unavailable after revocation;
- emergency stop cancels bounded network, render, export, and child-process work;
- vision-capable and text-only models receive the correct `analyze_render` result shape;
- text-only results never claim visual verification from deterministic metrics;
- provider secrets and sensitive response data are absent from project logs;
- project save, recovery, and undo remain valid after agent changes; and
- relevant Biome, TypeScript, Vitest, Rust format, Clippy, and Rust test gates pass.
