# After Effects workflow audit

Reviewed against Adobe's current documentation on 2026-09-12. This pass prioritizes composition
viewing and alignment. It does not claim complete After Effects feature parity.

| Common workflow | Aster finding | Result in this pass |
| --- | --- | --- |
| Fit the composition when a panel changes size | Fit reset to a fixed 25% scale; large compositions could remain cropped | Default live Fit, Fit up to 100%, smaller manual presets, and a shared fit command |
| Compare the current frame with a reference | Frame export and clipboard copying existed; a temporary comparison did not | One bounded snapshot, press-and-hold comparison, Shift+F5 / F5 in the viewer |
| Align content using rulers and custom guides | Composition grid and title/action safe overlays existed; custom guides did not | Pixel rulers, draggable guides, keyboard creation/nudging/deletion, guide locking, and layer snapping |
| Enter an exact preview time | Timeline timecode was display-only | Editable non-drop-frame timecode, seconds and frame counts, with validation and last-frame clamping |
| Keep preview controls together | Controls were spread across the app toolbar, panel header and footer | Composition/view controls above the image; magnification, time, snapshots, resolution and display options below |
| Work-area looping, precomposition, time remapping, graph editing | Implemented in the existing timeline/model | Existing behavior retained |
| Multiple viewers and scene-buffer inspection | Existing dock viewers and GPU buffer choices | Retained; fitting considers the space available to each displayed view |
| Navigate with the mouse wheel and Hand tool | Ctrl-only zoom and scrollbar-limited dragging | Switchable Smooth/Legacy navigation, pointer/center anchoring, and free viewer panning |

## Viewer behavior and boundaries

- Fit measures the viewer container in CSS pixels, independently of OS/UI scale, composition pixels and
  preview render resolution. Manual zoom spans 1–800%; fitting observes the same limits. Repeating
  Fit recenters the view. Panel resizing and navigation retain the render target at composition
  dimensions multiplied by preview quality.
- Navigation follows the AE 25.3+ Smooth Zoom defaults: wheel zoom anchors the composition point
  under the pointer; Alt/Option switches the anchor to the viewer center. Shift accelerates zoom
  and Ctrl/Command slows it down. Aster uses four-times and quarter-speed multipliers respectively;
  combining them returns to normal speed. Pixel, line, and page wheel deltas are normalized.
  The native non-passive wheel listener suppresses browser scrolling/zooming only on the viewer,
  leaving editable text controls alone. Menu zoom commands also preserve the viewer-center point.
- Preferences can switch navigation to Legacy. The wheel advances through fixed magnification
  levels (including 25%, 33.33%, 50%, 100%, and 200%) around the viewer center; Alt/Option anchors
  the pointer instead. Ctrl/Command + wheel pans vertically and Shift + wheel pans horizontally.
  Alt takes priority over panning; Shift selects the horizontal axis when both pan modifiers are held.
  Menu zoom commands use the same fixed levels. Switching modes preserves zoom and pan; the setting
  is saved in application preferences, independently of project content and preview resolution.
- Middle-button dragging or dragging with the Hand tool (H) pans freely even when the composition
  is smaller than the viewer. Shift triples drag speed, with no jump when the modifier changes.
  Pointer cancellation, capture loss, and window blur end the gesture. Navigation only changes
  CSS presentation, not project transforms, undo history, or preview render resolution.
- Snapshots copy the displayed canvas only on demand. One canvas per viewer is capped at 2048 pixels
  on its longest edge (at most 16 MiB at RGBA8). It is released on viewer disposal or context change.
  Holding the comparison button, Space/Enter on that button, or F5 over the canvas shows it;
  releasing, canceling, or losing focus restores the live frame. No per-frame CPU pixel readback is
  introduced, and comparison overlays never enter export.
- Custom guides are local viewing aids, stored under the project/composition identity in browser
  storage and shared by viewers of that composition. They are not portable project data or undoable
  project operations. Storage is validated and bounded to 128 guides per composition. Pointer moves
  update only a temporary guide; release commits its location, dragging outside removes it, and
  Escape/cancel restores the previous state. Hidden guides do not snap; locked guides remain snap
  targets. The existing Ctrl/Cmd modifier bypasses layer snapping.
- The horizontal ruler creates horizontal guides; the vertical ruler creates vertical guides.
  Enter or Space creates a centered guide, arrow keys move one pixel (Shift: ten), and Delete or
  double-click removes it. Guides and rulers use composition coordinates; they do not affect output.
- Time input accepts `HH:MM:SS:FF`, seconds such as `1.5s`, and frame counts such as `42f`. It shares
  non-drop-frame formatting with the timeline, including rational frame rates. Enter/blur commits;
  Escape discards the draft. Locked viewers of another composition cannot seek the active editor.

## Timeline navigation (2026-09-22)

- The time ruler, work-area handles, and playhead head remain pinned above vertically scrolling
  layers. Both playhead segments share the playback-frame position without rendering the layer list.
  Layer names and property labels stay fixed at the left while scrolling horizontally.
- `=` / `-` and the logarithmic zoom slider preserve the visible playhead position (or the view
  center when the playhead is offscreen). Alt/Option + wheel preserves the time under the pointer;
  plain wheel scrolls vertically, Shift + wheel scrolls horizontally, and middle-button dragging pans.
- `;` switches between frame units and the complete composition. Shift + `;` fits the composition
  and restores the previous scale and horizontal position on the next press. `D` centers the current
  time; `X` reveals the first selected layer. Fit uses the panel width instead of a fixed zoom floor.
- Page Up/Down and Ctrl/Command + Left/Right step one frame; Shift steps ten. Home/End visit the
  first/last frame; Shift + Home/End visit the work-area bounds. `I` / `O` visit selected layer bounds.
  Existing `B` / `N`, `J` / `K`, and bracket timing edits remain available. Out-point shortcuts account
  for the model's exclusive end boundary. Text entry, IME, menus, and modal dialogs keep their keys.
- Ruler ticks follow zoom and frame rate, and only visible ticks are mounted, including long
  compositions at frame zoom. This covers timeline navigation, not all AE property/editing shortcuts.
- Layer rows retain lightweight position shells; an IntersectionObserver shared by the timeline
  mounts row content within 240 pixels of the viewport. Measured heights and expansion state survive
  unmounting. Focused inputs and active drag sources stay mounted. This bounds expensive controls and
  playback subscriptions while retaining native scrolling, layer reveal, and marquee hit testing.
- Pointer moves share the existing animation-frame coalescer. A frame processes the latest position;
  pointer release flushes its final coordinates before committing, and cancellation discards pending
  work. Static snap targets are collected once per composition edit, not on every playhead move.

Production-browser stress check: 500 layers, a one-hour composition, 30 fps, and a 1200 × 500
timeline-only harness. Five warm updates per measurement; timings include two animation frames
and exclude composition rendering. These are local measurements, not a universal frame-rate guarantee.

| Scenario | Without row windowing | With row windowing |
| --- | --- | --- |
| Collapsed layers: mounted controls / DOM elements | 500 / 23,645 | 22 / 1,657 |
| Collapsed layers: median zoom update | 154 ms | 21 ms |
| 100 expanded layers: mounted controls / DOM elements | 500 / 40,545 | 2 / 1,075 |
| 100 expanded layers: median playback UI update | 324 ms | 14 ms |

The lightweight shells remain O(layer count); expensive row content and time subscriptions follow
the viewport. A single extremely dense visible keyframe track is a separate scaling limit.

## Remaining gaps identified

Separate follow-up work is needed for composition/layer marker metadata and editing, region-of-interest
rendering, preview-only exposure, and RGB channel isolation. Transparency-grid display also needs a
deliberate presentation contract: the current canvas is configured opaque, so a CSS checkerboard alone
would not correctly reveal composited alpha. These features are not represented by inactive controls.

## Sources

- [Adobe: modifying and using views](https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/modifying-using-views.html)
- [Adobe: previewing and snapshots](https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/previewing.html)
- [Adobe: keyboard shortcuts](https://helpx.adobe.com/after-effects/desktop/get-started/keyboard-shortcuts/keyboard-shortcuts-reference.html)
- [Adobe: mouse-wheel scrolling and zoom](https://helpx.adobe.com/hu/after-effects/using/general-user-interface-items.html)
- [Adobe: feature history (Smooth Zoom introduced in 25.3, June 12, 2025)](https://github.com/AdobeDocs/after-effects-feature-history)
