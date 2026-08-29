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

## UI integration constraints

The current model does not mount docking UI or create native floating windows. Integration should
preserve these boundaries:

- pointer movement may update a transient drop preview, while a layout operation commits only the
  chosen result;
- split dragging should coalesce visual updates and avoid rebuilding the React panel subtree;
- GPU preview surfaces must not be destroyed and recreated for every raw pointer event;
- durable persistence should occur after a committed dock, close, float, or resize transaction;
- monitor removal should remap floating bounds before applying them to a native window, without
  changing the stored panel tree.

Named workspace presets should wrap this layout document with preset identity and display metadata.
They should not introduce a second layout representation.
