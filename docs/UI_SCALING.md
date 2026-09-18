# UI scaling

Aster keeps interface scaling separate from composition magnification, preview quality, and output
resolution. Desktop profiles store either `auto` or a bounded 75–200% override. `auto` leaves the
Electron zoom factor at 1 so Chromium follows the operating system's per-display DPI scale. Manual
values apply through `webContents.setZoomFactor` before the project renderer loads.

The main process publishes the active display scale when a window moves between displays or Electron
reports a display scale change. Preview backing dimensions come from the composition's pixel
dimensions multiplied by preview quality (full, half, or quarter), rounded down to at least one
pixel and bounded proportionally by the GPU dimension limit. Viewer magnification, panel resizing,
UI scale, and device pixel ratio only affect presentation; they do not resize render targets.

Docked layout ratios remain scale-independent. Floating workspace bounds use fixed viewport CSS
coordinates and are reconciled against the dock host's measured left/top/right/bottom edges. A
display notification triggers an immediate safety clamp and a post-layout animation-frame
remeasurement; a `ResizeObserver` covers subsequent Chromium reflow. Only the post-clamp bounds are
persisted, so restored panels remain reachable after scale or monitor changes.

Transient context menus close when display metrics change, preventing stale inline coordinates.
Context menus and application-menu popovers are viewport-bounded and scroll internally when the
scaled viewport is shorter than their command list. Modal backdrops scroll while preferences keep
their header and footer fixed around a scrolling body.

The browser-only development surface uses CSS `zoom` as a fallback and reads the same bounded value
from local storage. It never applies this fallback in Electron, avoiding a double scale.

The composition viewer defaults to live Fit using its own container's CSS dimensions. Fit up to
100% caps enlargement; manual zoom supports 1–800%. Preview resolution remains independent. Viewer
controls wrap in groups when the dock becomes narrow. See [AE workflow audit](AE_WORKFLOW_AUDIT.md)
for snapshot, ruler, guide, and time-entry behavior and their persistence boundaries.

Wheel navigation uses the AE 25.3+ Smooth Zoom modifier mapping: pointer-centered by default,
Alt/Option for the viewer center, Shift for faster zoom, and Ctrl/Command for precision. Middle-button
or Hand-tool dragging pans the centered stage through a CSS translation; Shift speeds it up.
Pointer coordinates are converted back to CSS pixels so UI scaling does not change anchor placement
or drag distance. Fit resets the local pan offset. No navigation gesture resizes the backing texture.

## Control styling

`src/styles/controls.css` provides the shared appearance for native inputs, selects, textareas,
checkboxes, color swatches and form action buttons. Colors, borders, radius and default height live
in the `--control-*` tokens in `src/styles/tokens.css`. Surface styles retain layout and compact
heights for the timeline and inspector; avoid duplicating control colors and borders there.

Use native form elements to preserve labels, keyboard interaction and disabled semantics. Use
`control-button` for standalone form actions outside the existing dialog and panel action groups.
Toolbar tools, tabs and keyframe buttons keep their specialized states. Focus and disabled styling
is shared across controls; forced-colors mode restores native checkbox and select rendering.

The shell uses neutral dark surfaces, blue selection accents, a 46-pixel activity rail, and dock
groups with seven-pixel corner radii separated by six-pixel splitters. Shared surface and control
tokens keep menus, dialogs, sidebars, and editing panels consistent. Primary labels use 12-pixel
type; compact numeric and metadata fields keep their dedicated density. The centered project title
opens the command palette and yields space to menus in narrower windows.

The inspector keeps selected-layer identity pinned while scrolling. Layer-specific content (text,
shape, solid, audio, or scene controls) appears in an initially expanded section; compositing and
cloning have separate sections. Native details and disabled fieldsets preserve keyboard and lock
behavior without another UI dependency.

## Performance constraints

- UI scale changes do not modify composition pixels or export dimensions.
- Preview dimensions remain capped by `calculatePreviewSize` at the GPU texture dimension limit.
- A viewport resize is skipped when the calculated backing dimensions have not changed.
- Display listeners are removed with their owning window and renderer component.
- Overlay command surfaces preserve a six-pixel viewport margin in CSS coordinates at every scale.

## Adobe behavior reference

Adobe distinguishes Composition panel magnification from composition pixel dimensions and tracks
HiDPI/per-display scaling fixes separately. Aster follows those boundaries while adding an explicit
manual override requested by users.

- <https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/modifying-using-views.html>
- <https://helpx.adobe.com/after-effects/desktop/troubleshooting/fixed-and-known-issues/fixed-issues.html>
