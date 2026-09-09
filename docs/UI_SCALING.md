# UI scaling

Aster keeps interface scaling separate from composition magnification, preview quality, and output
resolution. Desktop profiles store either `auto` or a bounded 75–200% override. `auto` leaves the
Electron zoom factor at 1 so Chromium follows the operating system's per-display DPI scale. Manual
values apply through `webContents.setZoomFactor` before the project renderer loads.

The main process publishes the active display scale when a window moves between displays or Electron
reports a display scale change. The viewport recomputes its backing texture from current CSS bounds,
device pixel ratio, preview quality, and the GPU dimension limit. This notification is necessary
because a device-pixel-ratio change does not always produce a `ResizeObserver` entry.

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

## Control styling

`src/styles/controls.css` provides the shared appearance for native inputs, selects, textareas,
checkboxes, color swatches and form action buttons. Colors, borders, radius and default height live
in the `--control-*` tokens in `src/styles/tokens.css`. Surface styles retain layout and compact
heights for the timeline and inspector; avoid duplicating control colors and borders there.

Use native form elements to preserve labels, keyboard interaction and disabled semantics. Use
`control-button` for standalone form actions outside the existing dialog and panel action groups.
Toolbar tools, tabs and keyframe buttons keep their specialized states. Focus and disabled styling
is shared across controls; forced-colors mode restores native checkbox and select rendering.

## Performance constraints

- UI scale changes do not modify composition pixels or export dimensions.
- Preview device scale remains capped by `calculatePreviewSize` to prevent unbounded GPU allocations.
- A viewport resize is skipped when the calculated backing dimensions have not changed.
- Display listeners are removed with their owning window and renderer component.
- Overlay command surfaces preserve a six-pixel viewport margin in CSS coordinates at every scale.

## Adobe behavior reference

Adobe distinguishes Composition panel magnification from composition pixel dimensions and tracks
HiDPI/per-display scaling fixes separately. Aster follows those boundaries while adding an explicit
manual override requested by users.

- <https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/modifying-using-views.html>
- <https://helpx.adobe.com/after-effects/desktop/troubleshooting/fixed-and-known-issues/fixed-issues.html>
