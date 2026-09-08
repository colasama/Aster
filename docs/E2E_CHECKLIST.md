# Aster End-to-End Verification

Test date: 2026-08-30 (Asia/Hong_Kong)

Release under test: Aster 0.2.0, commit `5b68fd1`

Evidence labels:

- `[Desktop]` was exercised by controlling the packaged Windows application.
- `[Automated]` is covered by the repository validation suite.
- `[Artifact]` was verified from a generated file or archive.
- `[Docs]` is matched to the Adobe behavior references in the linked implementation document.

## Validation environment

- Windows 11 10.0.26100 x64
- AMD Ryzen 9 8945HX, 16 cores / 32 logical processors
- NVIDIA GeForce RTX 5060 Laptop GPU, driver 32.0.15.9621
- WebGPU high-performance adapter, Blackwell architecture, timestamp queries enabled, maximum texture size 8192
- Node 22.18.0, pnpm 10.15.0, Rust 1.97.1

## Build and startup

- [x] `[Automated]` `pnpm check`: Biome checked 651 files; TypeScript completed; Vitest passed 1,289 tests with 1 intentional skip across 230 files; all 5 packaging tests passed; Rust formatting, Clippy with warnings denied, and workspace tests passed. Hardware-only native GPU/FFmpeg tests remained explicitly ignored.
- [x] `[Artifact]` `pnpm artifact:build` produced the unpacked application and Windows installer.
- [x] `[Desktop]` Launched `release/win-unpacked/Aster.exe`, reached Ready through WebGPU on the high-performance adapter, and closed through the normal application path.
- [x] `[Desktop]` Restarted the packaged application after workspace and scale changes; the 100% scale and saved default workspace state were restored.
- [x] `[Desktop]` Final restart session `d6d3c1e0-13e0-4163-9b88-0f3df3836bc1` logged 11 `info` events, including project load, WebGPU initialization, viewport Ready, and graceful shutdown, with zero warning/error events.

## Release artifacts

| Artifact | Bytes | SHA-256 | Verification |
| --- | ---: | --- | --- |
| `release/win-unpacked/Aster.exe` | 235,621,376 | `0DF26E728392C292A08B420D3948AE1EE4681F1018B2885D58A19790A0C0E627` | Launched twice; Authenticode `NotSigned` |
| `release/win-unpacked/resources/app.asar` | 83,626,077 | `88ECD533E7391786E4FFD622EE9BAC007748D9DD8B53CC8F659B41FDF221BE25` | Loaded by packaged app |
| `release/Aster-0.2.0-windows-x64.exe` | 158,223,609 | `89A3ED6FFB0C2FDEDE76B5AA27FD899EF71AB2BF110B86042D3F6B29A7032EAD` | Authenticode `NotSigned` |

The unsigned status is recorded as release metadata, not a runtime failure. Production distribution still requires a signing identity.

## Project lifecycle

- [x] `[Desktop]` Opened the native `Aster-Final-E2E-20260830` bundle from Recent Projects, edited it, saved it, and confirmed the saved notification.
- [x] `[Artifact]` The saved document is 94,290 bytes with SHA-256 `79E9A1AE59B3B607FF3790964498FC960C6BD083178F7971F725E55C508D3B7D`; it contains 2 compositions, 12 sources, 12 external media entries/payloads, and 14 layers in the active 4K composition.
- [x] `[Desktop]` Packed the project to `Aster-Final-E2E-v2.aster`, chose a new parent directory, unpacked it, and loaded the extracted project in the application.
- [x] `[Artifact]` The packed project is 126,567 bytes with SHA-256 `CEAD55B9A3752888D6917D7230BB1DFEA7120CC2200AE66E4B52356F8923B2D4`; the archive and extracted bundle both contain exactly `project.json` plus 12 media files.
- [x] `[Desktop]` Reopening the packed project restored all advanced sources without a missing-media diagnostic.
- [x] `[Automated]` Project replacement guards, autosave/recovery scoping, recent-project failure handling, version migration, command history, deduplication, and native persistence are covered by the project lifecycle suites.
- [ ] `[Desktop]` Manually exercise Save As, rejecting an autosave recovery, and opening a deliberately removed Recent Projects entry.

## Professional dock workspace

- [x] `[Desktop]` Maximized and restored the Composition panel group.
- [x] `[Desktop]` Floated the Render Queue group into its own host and docked it back into the main workspace.
- [x] `[Desktop]` Dragged the vertical splitter and confirmed the viewer/timeline recomputed their geometry without stale hit targets.
- [x] `[Desktop]` Closed Render Queue and reopened it from Window > Panels.
- [x] `[Desktop]` Switched among Default, Animation, and Minimal workspace presets, then returned to Default.
- [x] `[Desktop]` Restarted the packaged application and confirmed workspace/tab selection persistence.
- [x] `[Automated]` Tab reordering, all four split edges, drag overlays, floating bounds, resize handles, panel close/reopen, workspace save/reset/undo, viewport locking/splitting, and migration are covered by the workspace suites.
- [ ] `[Desktop]` Manually drag one tab to each of the four split-edge targets and exercise Workspace Save As/rename/delete/reset.

Reference: [workspace and context-menu audit](WORKSPACE_CONTEXT_AUDIT.md).

## Menus, context actions, scaling, and diagnostics

- [x] `[Desktop]` Opened application menus and a layer context menu; verified action routing, disabled commands, dismissal, and undo/redo safety.
- [x] `[Desktop]` Used File, Edit, Layer, Window, and Render Queue actions through their visible UI paths.
- [x] `[Desktop]` Applied 75%, 100%, 125%, 150%, 175%, and 200% UI scales and kept title-bar controls, menus, dialogs, panels, scroll containers, and timeline controls reachable; restored 100% at the end.
- [x] `[Automated]` Auto, 87.5%, and 112.5% scale values plus popover clamping, viewport coordinate mapping, persisted scale migration, and window drag regions are covered by UI scaling tests.
- [x] `[Desktop]` Observed actionable render failures with Retry/Remove controls, a missing image-sequence frame diagnostic, and native picker validation without corrupting the active project.
- [x] `[Automated]` Structured error scope, cause chains, diagnostic codes, correlation IDs, detail copy, deduplication, dismissal, logging, import validation, and render-host terminal reporting are covered by the diagnostics suites.
- [ ] `[Desktop]` Import a deliberately corrupt image and exercise plugin and AI-provider failures in configured third-party environments.

References: [UI scaling](UI_SCALING.md), [workspace and context-menu audit](WORKSPACE_CONTEXT_AUDIT.md).

## Layers, timeline, and graph editor

- [x] `[Automated]` Text, shape, solid, null, image, video, independent audio, precomposition, camera, light, mesh, generator, particle, and adjustment-layer construction/defaults are covered.
- [x] `[Desktop]` Exercised text, shape, footage, independent audio, camera, 3D shape, particle, and adjustment/effect layers in the final project.
- [x] `[Desktop]` Scrubbed and played video/audio footage to `00:00:09:30`; independent audio produced no visual geometry.
- [x] `[Desktop]` Locked-layer mutation was rejected; visibility, solo, audio, 3D, and motion-blur switches exposed the correct enabled/disabled state.
- [x] `[Desktop]` Opened the Graph Editor for camera aperture, text animator amount, and transform properties; observed real curves and moved between timeline/graph views.
- [x] `[Automated]` Value and Speed graphs cover scalar/vector components, temporal ease/influence, velocity handles, adaptive sampling, selection, keyframe move/scale, interpolation, Easy Ease, copy/paste, delete, and undo/redo.
- [x] `[Automated]` Null non-rendering, Solid color/size rendering, Audio non-visual mixing, parenting, trim, slip, split, reorder, labels, in/out points, and time remapping are covered.
- [ ] `[Desktop]` Manually create every layer kind from an empty composition and perform every trim/slip/split/parent/time-remap gesture in one session.

References: [Graph editor](GRAPH_EDITOR.md), [Audio layers](AUDIO_LAYERS.md), [Project format](PROJECT_FORMAT.md).

## Camera and depth of field

- [x] `[Desktop]` Created and edited a 3D camera, Point of Interest, orientation/rotation, Zoom, horizontal film size, focal length, focus distance, focus area, aperture, f-stop, bokeh controls, and active-camera view.
- [x] `[Desktop]` Enabled depth of field, scrubbed evaluated camera values, and graphed animated aperture.
- [x] `[Desktop]` Used the 3D viewport World X manipulator and verified undo/redo.
- [x] `[Automated]` One-node/two-node behavior, parenting, active-camera stacking, perspective/orthographic projection, framing, film-back math, legacy field-of-view migration, focus lock, near/far signed circle of confusion, occlusion, transparent edges, quality scaling, and deterministic time evaluation are covered.
- [x] `[Docs]` Camera and DOF units, 72-dpi aperture conversion, focus-plane semantics, bokeh defaults, and preview/export ordering match the Adobe reference baseline.
- [ ] `[Desktop]` Capture a manual visual matrix for every bokeh shape/roundness/aspect/highlight-gain combination.

Reference: [Camera and depth of field](CAMERA_AND_DEPTH_OF_FIELD.md).

## Motion blur

- [x] `[Desktop]` Enabled the active composition switch and ASTER text-layer switch independently, moved to an in-between animated frame, and played the WebGPU preview in real time.
- [x] `[Desktop]` Saved, packed, unpacked, and reopened the project with composition motion blur enabled and the ASTER layer switch preserved.
- [x] `[Automated]` Two-switch gating covers text, shape, solid, footage, and 3D layers; unsupported particle/camera layers correctly disable their per-layer switch.
- [x] `[Automated]` Shutter angle/phase, frame-rate dependence, adaptive sample count/limit, occlusion, premultiplied alpha, HDR, cache invalidation, DOF ordering, display transform, and preview/export shared Beauty input are covered.
- [ ] `[Desktop]` Export a manual visual matrix for 0°, 90°, 180°, 360°, and 720° shutters at centered and offset phases.

Reference: [Motion blur](MOTION_BLUR.md).

## Text animators

- [x] `[Desktop]` Added and inspected text animator groups, range selectors, animated Amount, timeline tracks, and graph curves.
- [x] `[Desktop]` Edited ASTER text inline in the Composition viewer, committed with Ctrl+Enter, and verified undo.
- [x] `[Automated]` Animator group add/rename/reorder/enable/duplicate/delete and Range, Wiggly, and Expression selectors are covered.
- [x] `[Automated]` Selector modes/units/domains/shapes/easing/smoothness/random order/correlation/phases/seeds and arbitrary-time deterministic evaluation are covered.
- [x] `[Automated]` Per-character anchor, position, scale, 3D rotation, skew/axis, opacity, fill/stroke, stroke width, tracking, line anchor/spacing, character offset/value, blur, grapheme clusters, Unicode, whitespace, multiline layout, expression errors, and cache invalidation are covered.
- [ ] `[Desktop]` Manually inspect every selector domain and every per-character property across a Unicode multiline stress document.

Reference: [Text animators](TEXT_ANIMATORS.md).

## Media import and playback

- [x] `[Desktop]` Imported PNG, JPEG, WebP, AVIF, GIF, BMP, and TIFF; every source decoded as 96×64 and remained available after project save/pack/unpack.
- [x] `[Desktop]` Imported SVG at 320×180, transformed it in the 4K viewer, reopened it, and rendered through the hidden render host after the SVG rasterization fix.
- [x] `[Desktop]` Imported PSD as a retained-size composition/source (`Red Green`, 2×1) and reopened it with correct bounds/pixel placement.
- [x] `[Desktop]` Imported `shot.[####].png` at 32×32 and verified missing-frame error behavior.
- [x] `[Desktop]` Imported 320×180 H.264 MP4 (2.0 s) and WAV (1.5 s), played them, saved, restarted, packed, and reopened without missing media.
- [x] `[Automated]` Alpha/color interpretation, EXIF orientation, TIFF fallback, SVG identity/raster cache, PSD merged/retained/composition modes with raw/RLE/ZIP channels, sequence rational time/missing policies/bounded cache, media relink/deduplication, and cancel/error atomicity are covered.
- [ ] `[Desktop]` Manually exercise media relink and a deliberately corrupt/unsupported payload.

References: [SVG import](SVG_IMPORT.md), [PSD import](PSD_IMPORT.md), [Image sequence import](IMAGE_SEQUENCE_IMPORT.md).

## Direct viewport editing

- [x] `[Desktop]` Selected and dragged ASTER directly in the Composition viewer, then verified Ctrl+Z/Ctrl+Y.
- [x] `[Desktop]` Edited text inline at preview resolution and committed/cancelled through the viewer path.
- [x] `[Desktop]` Used a 3D axis manipulator and verified time-addressed transform editing and undo.
- [x] `[Desktop]` Selected imported raster/vector footage and observed crisp overlay geometry in the 4K composition.
- [x] `[Automated]` Eight resize handles, rotation, anchor preservation, Shift aspect lock/15° rotation, Alt center scaling, negative flips, Ctrl snap suppression, guides, multi-selection, parenting, locked/hidden exclusions, cancel, undo grouping, coordinate mapping, and 25%–800% magnification are covered.
- [ ] `[Desktop]` Manually perform all eight resize handles and modifier combinations on each supported visual layer kind.

## Background render and preview/output parity

- [x] `[Desktop]` Added a 4K/60 fps/full-composition H.264 job, started it in the isolated hidden render host, paused at frame 224, resumed, and completed all 720 frames.
- [x] `[Desktop]` Cancelled a second job at frame 179, confirmed no final output or staging residue, retried from frame 0, and completed it.
- [x] `[Desktop]` Cancelled a final cleanup smoke at frame 255, confirmed zero temporary encoder files and no cancelled destination, then removed the job.
- [x] `[Desktop]` Recovered a previously interrupted job, surfaced its precise failure, and exercised Retry and Remove.
- [x] `[Artifact]` `Main-4K-bitrate-20Mbps.mp4` is 30,380,823 bytes, SHA-256 `4B79E5B96E437AA83661EFDB27E53A49E0C78F35D965E9DC23384FBC99E9BF83`; ffprobe reports H.264 Main, 3840×2160, yuv420p, BT.709, 60/1 fps, 12.000 s, exactly 720 frames, and 20,247,406 bit/s video bitrate (1.24% above the 20 Mb/s target).
- [x] `[Artifact]` `aster-frame-4k.png` is 2,347,746 bytes, 3840×2160, SHA-256 `3DFCE11104DA048072141637FD11FA62C8247EB3722D5AD5621D5739618BE541`.
- [x] `[Automated]` Preview, still, PNG sequence, and MP4 consume the same canonical full-resolution Beauty readback before output encoding; preview resolution is only a display/downsampling choice. Renderer dimensions, motion blur, DOF, text, SVG/PSD, effects, and color-transform parity are regression-tested.
- [x] `[Automated]` Immutable snapshots, job IDs, serialized lease retirement, pause/resume/cancel/retry/remove, recovery, progress/ETA, path safety, backend identity, MP4 bitrate propagation, and bounded staging cleanup are covered.
- [ ] `[Desktop]` Export a composition with audible audio and verify muxed sample rate, channel count, sync, and listening output.

References: [Production render contract](PRODUCTION_RENDER_CONTRACT.md), [Render queue](RENDER_QUEUE.md).

## Performance and resilience

- [x] `[Desktop]` Ran the packaged GPU quick benchmark for 60 frames per scenario; the application logged completion in 2,285 ms.
- [x] `[Desktop]` 1080p current composition: median 1.57 ms, p95 1.71 ms.
- [x] `[Desktop]` 4K current composition: median 6.75 ms, p95 7.34 ms.
- [x] `[Desktop]` 20-layer 1080p composite: median 1.97 ms, p95 2.16 ms.
- [x] `[Desktop]` Blur + glow chain: median 0.13 ms, p95 0.20 ms.
- [x] `[Desktop]` GPU particles: 100K 0.20/0.20 ms, 500K 0.26/0.26 ms, 1M 0.33/0.33 ms (median/p95).
- [x] `[Desktop]` Continued editor interaction while background rendering; pause/cancel convergence did not freeze the main window.
- [x] `[Automated]` Renderer lifetime, resize generation guards, stale async completion rejection, GPU residency, bounded footage/sequence caches, render-host isolation, and benchmark binding to a live viewer are covered.
- [ ] `[Desktop]` Run an overnight preview/render soak and record process-private memory and VRAM over time.

## Defects found and fixed during desktop E2E

| Commit | Finding | Resolution |
| --- | --- | --- |
| `bf6c55e` | Full-resolution Beauty readback could bind to stale dimensions | Bound readback to live renderer dimensions |
| `7b6207e` | A failed hidden renderer could lose its terminal state | Sent the strict terminal IPC shape and added a close fallback |
| `6c04930` | Hidden render hosts failed to decode an SVG Blob with `createImageBitmap` | Added deterministic DOM Image/canvas SVG rasterization fallback |
| `bd6e660` | A pause-requested render could not be cancelled | Kept Cancel enabled through pause convergence |
| `e779c9c` | MP4 ignored its requested bitrate and produced about 121 Mb/s | Propagated and verified bitrate in the immutable manifest and bounded FFmpeg VBR |
| `5b68fd1` | An abandoned encoder staging file survived a terminated process | Added bounded, ownership-safe stale staging cleanup |

## Sign-off

- [x] Every feature requested for this milestone has implementation coverage, an Adobe-aligned behavior document where applicable, automated regression coverage, and at least one representative packaged-desktop path.
- [x] The final production build, native project, packed project, 4K still, 4K MP4, GPU benchmark, restart persistence, and final clean log session were verified.
- [ ] Optional exhaustive desktop matrices listed above remain suitable for extended QA; unchecked entries are intentionally not claimed as manually exercised.
