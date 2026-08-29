# UI scaling

Aster keeps interface scaling separate from composition magnification, preview quality, and output
resolution. Desktop profiles store either `auto` or a bounded 75–200% override. `auto` leaves the
Electron zoom factor at 1 so Chromium follows the operating system's per-display DPI scale. Manual
values apply through `webContents.setZoomFactor` before the project renderer loads.

The main process publishes the active display scale when a window moves between displays or Electron
reports a display scale change. The viewport recomputes its backing texture from current CSS bounds,
device pixel ratio, preview quality, and the GPU dimension limit. This notification is necessary
because a device-pixel-ratio change does not always produce a `ResizeObserver` entry.

The browser-only development surface uses CSS `zoom` as a fallback and reads the same bounded value
from local storage. It never applies this fallback in Electron, avoiding a double scale.

## Performance constraints

- UI scale changes do not modify composition pixels or export dimensions.
- Preview device scale remains capped by `calculatePreviewSize` to prevent unbounded GPU allocations.
- A viewport resize is skipped when the calculated backing dimensions have not changed.
- Display listeners are removed with their owning window and renderer component.

## Adobe behavior reference

Adobe distinguishes Composition panel magnification from composition pixel dimensions and tracks
HiDPI/per-display scaling fixes separately. Aster follows those boundaries while adding an explicit
manual override requested by users.

- <https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/modifying-using-views.html>
- <https://helpx.adobe.com/after-effects/desktop/troubleshooting/fixed-and-known-issues/fixed-issues.html>
