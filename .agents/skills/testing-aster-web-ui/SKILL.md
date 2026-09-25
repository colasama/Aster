---
name: testing-aster-web-ui
description: How to run and drive the Aster studio editor UI in a browser for end-to-end testing (dev server, shortcuts, menu/context-menu triggers, gotchas).
---

# Testing the Aster studio editor UI in a browser

## Running the app

- `pnpm dev:web` runs Vite only (no Electron/Rust bridge needed) on `http://localhost:1420`.
- A dev server is often already running — check `lsof -nP -iTCP:1420 -sTCP:LISTEN` before starting a new one. A second `pnpm dev:web` fails with "Port 1420 is already in use"; an existing server still serves the current working tree, so reuse it.
- **bundledDev mode**: the Vite config uses `experimental.bundledDev` (Rolldown full-bundle dev). The page loads `/assets/index.js` (one bundle), NOT `/src/*` dev modules — fetching `/src/...` returns the SPA fallback HTML. To verify a change is actually being served, grep the bundle: `curl -s localhost:1420/assets/index.js | grep -o "your-css-or-js-string"`.
- **After a branch switch, restart the dev server.** A long-running bundledDev instance can serve a stale/broken graph — the page renders permanently blank even though `/` and `/assets/index.js` return 200. Fix: `kill <vite-pid>`, `pnpm dev:web`, hard reload the tab.
- The app boots with a sample project ("Aster Launch" → composition "Main - 4K") containing a text layer with keyframes — enough for most UI flows without creating content.

## Driving the UI

- App menus: click File/Edit/... in the top-left menu bar; popovers appear under the menu name.
- Command palette: `Ctrl+K` (also listed as a menu item).
- Save toast: `Ctrl+S` — in web mode it downloads the project `.aster.json` blob AND shows the `.app-toast` bottom-right. The toast auto-dismisses in ~2.4s, so screenshot immediately.
- Context menus: right-click the composition viewport canvas, timeline layer rows, keyframes, or inspector transform fields. Enabled entries highlight blue on `:hover` (destructive entries highlight red; `:not(:disabled)` means disabled entries never highlight). Submenu parents also highlight via `.submenu-open` and open their submenu on pointer-enter — moving the pointer diagonally into a submenu can cross a sibling entry and close it (move horizontally instead). Keyboard arrows highlight entries via `:focus-visible`.
- Tabs: "Timeline"/"Graph Editor" tabs sit above the timeline panel; right panel has "Inspector"/"Render Queue" tabs — select a layer first or Inspector stays empty.
- Reduced motion: Edit → Preferences → "Reduce non-essential interface motion" checkbox → Save preferences (persists in `localStorage` key `aster.reducedMotion`, toggles `.reduced-motion` on `documentElement`). Restore it afterward.
- Panel resize: the workspace splitters are thin (`--workspace-gap`) — drag slowly from the exact panel edge; a blue `.workspace-split-preview` line appears mid-drag.
- Loading a project file: File → "Open…" opens the native macOS picker → `Cmd+Shift+G` for the "Go to folder" sheet → type the absolute path → Return selects the file → click Open. Web mode then shows a `window.confirm` "Discard unsaved changes?" — click OK. The project must pass the document validator (e.g. `workArea` must fit inside `duration`) or a diagnostic banner rejects the load.
- Scrubbing the playhead: the timeline ruler's TOP ~8px is a `.work-area-move` overlay that swallows pointerdown (drags the work area instead of scrubbing). Click the BOTTOM of the ruler strip (on the `0:00`/`0:01` labels) to scrub, or press Space to play/pause.
- Inspecting the live document: `Ctrl+S` downloads the current project `.aster.json` to `~/Downloads/` — the file reflects post-import/normalization state, useful for checking what a layer actually became (kind, keyframe modes, threeDimensional flags).
- DevTools: `browser_console`/`read_dom` tools are unreliable here, but native Chrome DevTools works — `Cmd+Opt+J` toggles the console where you can evaluate expressions (`navigator.gpu` to confirm the WebGPU backend, etc.). The app's `aster` script API and `__asterQuery`/`__asterCommand` only exist inside QuickJS, not the page context.
- Renderer paths: the viewport uses WebGPU when `navigator.gpu.requestAdapter()` succeeds, else `CanvasFallbackRenderer` (which draws precomp surfaces as flat placeholder rects — never renders inner content or cameras). Check the `[renderer:viewport] renderer_ready {backend: ...}` console log or `navigator.gpu` to know which path you're seeing.

## Environment gotchas

- The `browser_console` and `read_dom` tools may report "Chrome is not in the foreground" even when it visually is (e.g. after a macOS notification steals focus, or stale state). Use screenshot `zoom` regions for fine visual checks (1px separators, 9px kbd glyphs, hover states) instead of computed-style probing.
- Clicking a macOS notification (e.g. "App Background Activity") opens System Settings and steals Chrome's foreground — dismiss notifications before recording.
- `left_mouse_down`/`left_mouse_up` take no coordinates: `mouse_move` to the target first, then press.
- Cannot nest `annotate_recording` inside `computer` action batches — call it as its own tool.

## Devin Secrets Needed

- None.
