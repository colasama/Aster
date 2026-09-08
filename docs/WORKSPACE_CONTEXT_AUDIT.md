# Workspace and Context Menu Audit

Audit date: 2026-08-30. The behavior baseline is Adobe's current documentation for
[workspaces, panels, and viewers](https://helpx.adobe.com/ca/after-effects/desktop/get-started/get-familiar-with-the-interface/workspaces-panels-viewers.html),
[panel keyboard shortcuts](https://helpx.adobe.com/ie/after-effects/desktop/get-started/keyboard-shortcuts/keyboard-shortcuts-reference.html),
[composition basics](https://helpx.adobe.com/ca/after-effects/desktop/work-with-compositions/composition-settings/composition-basics.html),
and [layer selection and arrangement](https://helpx.adobe.com/mena_en/after-effects/desktop/work-with-layers/select-and-arrange-layers/selecting-arranging-layers.html).

## Verified behavior

| Adobe behavior | Aster implementation and verification |
| --- | --- |
| Group panels in a center target or dock them at an edge | Center and four-edge targets dispatch one immutable layout operation; model tests cover cross-group moves, exact tab slots, and empty-tree collapse. |
| Reorder tabs and move panels between groups | Pointer drops and `Ctrl/Cmd+Shift+PageUp/PageDown` preserve the active panel and persist one normalized change. |
| Resize adjacent panels | Splitters enforce pixel minimums. Pointer movement is a RAF-coalesced visual preview with one model/persistence commit on release. |
| Float, dock, close, and maximize panels or groups | Tab/group menus and controls use the same normalized operations and bounded layout undo history. Floating move and eight-way resize also commit once on release. |
| Switch panels with the wheel over the tab strip | Wheel input wraps through the group without changing keyboard focus; modified wheel input remains available to native zoom behavior. |
| Close the active panel from the keyboard | `Ctrl/Cmd+W` closes the focused group's active panel; `Ctrl/Cmd+Shift+W` closes the group. Both are undoable layout commits. |
| Preserve and reset named workspace layouts | The versioned catalog and layout stores validate input atomically. Reset uses the saved snapshot; active and built-in workspaces cannot be deleted. |
| Accessible panel and context-menu navigation | Tabs use `tablist`, `tab`, `tabpanel`, roving focus, `aria-selected`, and `aria-controls`. Menus use menu roles, disabled states, arrow/Home/End navigation, Escape dismissal, and focus restoration. |
| Switch a group between tabbed and stacked presentation | Workspace schema v2 persists presentation, expanded panels, and Solo state. Ctrl-click expands or collapses the complete stack; Alt-click toggles Solo while selecting the panel. Version 0/1 layouts migrate atomically. |
| Maximize or restore the panel group under the pointer | Double-click, the accent-grave shortcut, the group control, and the menu share one persisted layout operation. Closing the maximized group clears stale presentation state during normalization. |
| Lock, create, and split viewers | Viewer identities are independent of panel definitions. `Ctrl+Alt+Shift+N` locks the current identity and creates an unlocked split. A locked Composition viewer resolves its retained composition read-only, while render sessions continue to resolve the active composition from their requested project snapshot. |
| Keep multiple viewer frames live and bounded | Every visible split evaluates its own locked or active composition at the global time. A source panel is capped at four retained live viewers, preventing unbounded GPU canvas/device growth while keeping all visible frames meaningful. Project data remains shared. |
| Recover floating frames after display changes | The host remapper clamps frame size and position to the current Electron content host and rewrites `displayId` when the main window moves to another display. Panel nodes preserve identity. |

## Viewer and floating-host architecture

Viewer lock state is project-local. In line with Adobe's guidance that locked viewers should be
unlocked before saving a reusable workspace, serialization preserves viewer instances but clears
their lock and bound composition. In-memory locked identities retain the composition id. When that
composition is not the project's active composition, the Composition viewer renders it but removes
transform controls, camera gizmos, text editing, selection writes, layer creation, and composition
crop operations. Unlocking immediately follows the active composition again.

Aster intentionally keeps floating groups in the main renderer host. Electron cannot place one DOM
subtree in a second `BrowserWindow`; loading the editor there would create another `EditorProvider`
and divergent document state. The implemented host therefore provides floating frames
inside the native editor window, persists their display identity, and remaps unreachable bounds when
the native window crosses displays or the available display area changes. Floating groups do not yet
cross the main-window boundary onto a second monitor as independent native windows.

Unlike tabbed viewers, simultaneously visible split viewers must each present a live frame. Aster
therefore mounts one Composition surface per visible identity and caps retained identities at four
per source panel. This is a bounded correctness-first pool: each viewer shares the immutable project
snapshot and global time, but the current WebGPU surface wrapper owns per-canvas presentation state.
Closing a viewer disposes its renderer, decoded media, staging caches, GPU resources, and canvas
context; a renderer that finishes asynchronous initialization after unmount is disposed immediately.

## Context menu coverage

Timeline layer, keyframe, graph-key, property, and composition-view settings menus route commands through
typed editor operations or local view state. Menu construction is separated from rendering, so command
availability and destructive/disabled states are unit-tested without mounting GPU surfaces. Pointer and
keyboard invocation share the same trigger and viewport-clamped menu renderer.

Composition viewer commands open the existing Composition Settings transaction, reveal and reopen the
active composition's Project panel, and crop the composition to selected 2D world bounds. Crop shifts
every root layer's static or fully keyed position in the same undo transaction, preserving animation and
parented geometry. Timeline selection commands invert the active composition selection or add direct
children; the same selection commands are available from the Composition viewer. Split Layer creates
independent graph identities, preserves source-time continuity and external parenting, and updates both
halves in one undo transaction. Commands without a valid model operation are omitted instead of rendered
as disabled no-op entries.

These surfaces are backed by layout or editor operations rather than menu-only stubs.
