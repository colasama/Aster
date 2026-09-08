# Workspace Layout Model

Aster represents a workspace independently from React and the Electron window layer. The model is a
small immutable tree that can be evaluated, persisted, and tested without mounting the editor. This
separation keeps drag previews and workspace migrations out of project documents and gives the UI a
deterministic source of truth.

## Layout structure

The docked root is either empty or one of two node types:

- A `tabGroup` owns an ordered list of panel IDs and one active panel ID.
- A `split` owns two child nodes, a horizontal or vertical axis, and a bounded ratio.

Floating workspaces own the same node type, a stable ID, screen bounds, and an optional display ID.
Using a complete node below a floating entry allows a future native floating window to contain tabs
and nested splits instead of limiting it to one panel. Closed panel IDs remain part of the layout so
the Window menu can reopen them without making panel availability part of project state.

Panel IDs and node IDs are stable application identifiers. UI component instances, DOM nodes, and
renderer resources are deliberately not stored in the layout.

## Operations and invariants

`src/workspace/layout.ts` provides operations for grouping and edge docking, floating, closing,
reopening, resizing splits, and normalization. The following invariants hold after normalization:

- a panel appears at most once across docked and floating nodes;
- every tab group is non-empty and its active panel belongs to it;
- empty groups and redundant splits collapse deterministically;
- split ratios remain between `0.1` and `0.9`;
- floating bounds are finite and bounded;
- visible panels are not also closed, and closed IDs are unique and sorted.

Operations use structural sharing. Tree searches stop after finding the target, and only ancestors of
the changed node are copied. Unaffected branches, floating arrays, and closed-panel arrays retain
their references. No-op operations return the original layout object. This behavior is important for
React selectors and for keeping pointer-driven docking work proportional to tree depth rather than
the number or complexity of mounted panels.

Generated IDs use the first available deterministic suffix for their node kind. The same operation
on equivalent layouts therefore produces equivalent documents, which makes undo records and tests
stable.

## Persistence boundary

`src/workspace/layout-schema.ts` owns the versioned persistence boundary. Version 1 stores the docked
root, floating entries, and closed panels. The reader also recognizes the same unversioned shape as
version 0 and migrates it to version 1.

The reader validates depth, collection sizes, node identity, active tabs, axes, ratios, bounds, and
finite numeric values before a layout reaches editor state. Malformed, over-sized, or future-version
documents fall back atomically to a caller-supplied safe layout. Recoverable canonicalization, such
as duplicate panel entries or a divider at an extreme ratio, happens in the normalizer. Serialization
returns a detached plain document so persistence code cannot mutate live editor state.

Workspace documents belong in application preferences, not `.aster` project files. Opening a project
must not silently replace the user's active workspace unless a later explicit preference enables that
behavior.

## Dock renderer and interaction transactions

`src/components/workspace` renders the immutable tree directly. Groups own an accessible,
overflowing tab strip and a host for the active panel's existing actions. This lets legacy `Panel`
callers keep their content and tool buttons while the workspace owns layout tabs, close, float, and
maximize controls. Project, Composition, Inspector, Timeline, Graph Editor, and Profiler are stable
panel registry entries rather than fixed CSS grid cells.

Embedded panel subtabs use a separate row with roving keyboard focus; timeline and graph surfaces
use their workspace tabs directly. Each surface owns its display mode, so both can remain visible
without competing over a shared mode switch. Revealing an existing panel activates its dock tab.

Panel and group drags expose four edge zones for splitting and one center zone for grouping. A drop
maps to exactly one model operation and one persistence write. Closing records the panel ID and the
workspace API can reopen it into a chosen or most recently hovered group. Double-clicking a group
header, or pressing the backtick key over a group, maximizes it without changing the durable tree.
Rolling the pointer wheel over a tab strip switches its active panel without stealing keyboard focus.
`Ctrl/Cmd+W` closes the active panel and `Ctrl/Cmd+Shift+W` closes its focused panel group. Tab
activation, reordering, and group focus use roving-tab keyboard semantics.

Splitter movement is an explicit preview transaction. Raw pointer values are coalesced with
`requestAnimationFrame`, but only a lightweight divider preview moves. The split ratio and real DOM
geometry commit once on pointer release, so a WebGPU canvas observes one resize instead of allocating
surfaces for every pointer event. Floating-group movement similarly uses a transform preview and
persists bounds only on release.

The active layout is stored under `aster.workspace.layout.v1`. Reads pass through the versioned
schema boundary; malformed JSON, rejected storage access, invalid data, and future schema versions
fall back atomically to the default layout. Layout preferences remain separate from `.aster` project
documents.

## Named workspaces

The versioned catalog at `aster.workspace.catalog.v1` records the current workspace and custom
workspace snapshots. Default, Animation, and Minimal are built-in snapshots and cannot be renamed or
deleted. Save As captures the current immutable layout, normalizes the name, and adds a deterministic
numeric suffix when the name already exists. Custom workspaces can be renamed or deleted; deletion
requires confirmation, presents only inactive custom workspaces, and rejects active-workspace deletion
at the immutable catalog boundary.

The live layout and named snapshot are intentionally distinct. Startup restores both the current
workspace identity and its last live layout. Selecting a workspace loads its saved snapshot, while
Reset to Saved Layout discards live changes through the same undoable layout transaction used by
docking. This matches the expectation that reset has a stable target instead of continuously
overwriting the saved snapshot during pointer interaction.

The Window menu exposes every registered panel as a checked menu item, so closing and reopening are
the same model operations whether invoked from a tab or the application menu. Tab and group context
menus provide close, close others, close group, float or dock, maximize, grouping, and split moves.
Layout-destructive commands enter a bounded undo stack and can be reverted with the menu command or
`Ctrl/Cmd+Alt+Z`; deleting a named workspace uses an explicit confirmation instead.

Native multi-window floating and monitor-removal remapping remain later integration work. Monitor
changes must adjust window bounds without creating another panel-tree representation.

Named workspace presets should wrap this layout document with preset identity and display metadata.
They should not introduce a second layout representation.
