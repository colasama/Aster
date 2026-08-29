# After Effects Workspace and Context Menu Audit

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

The following Adobe surfaces require later, explicitly owned slices rather than workspace changes:

- stacked panel groups and solo expansion need a persisted group presentation model;
- locked or split viewers need multiple viewer instances and viewer identity;
- native floating windows and monitor remapping need an Electron window host (the current schema already
  reserves `displayId`);
These are not emulated with menu-only stubs: unavailable commands remain absent until their underlying
operation and state ownership exist.
