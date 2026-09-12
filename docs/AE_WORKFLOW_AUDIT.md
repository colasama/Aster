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

## Viewer behavior and boundaries

- Fit measures the scroll host in CSS pixels, independently of OS/UI scale, composition pixels and
  preview render resolution. Manual zoom spans 1–800%; fitting observes the same limits. Repeating
  Fit recenters the view. A split resize still commits geometry through the existing workspace
  transaction before GPU textures resize.
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

## Remaining gaps identified

Separate follow-up work is needed for composition/layer marker metadata and editing, region-of-interest
rendering, preview-only exposure, and RGB channel isolation. Transparency-grid display also needs a
deliberate presentation contract: the current canvas is configured opaque, so a CSS checkerboard alone
would not correctly reveal composited alpha. These features are not represented by inactive controls.

## Sources

- [Adobe: modifying and using views](https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/modifying-using-views.html)
- [Adobe: previewing and snapshots](https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/previewing.html)
- [Adobe: keyboard shortcuts](https://helpx.adobe.com/after-effects/desktop/get-started/keyboard-shortcuts/keyboard-shortcuts-reference.html)
