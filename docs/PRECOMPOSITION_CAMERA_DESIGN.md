# Precomposition camera and rendering design

Status: proposal, not implemented. Investigation date: 2026-09-22.

## Objective

An ordinary precomposition must preserve its own camera animation when placed in another
composition. Adopt After Effects' distinction between ordinary nesting and explicit Collapse
Transformations. A layer's 3D switch must remain independent of that distinction.

## Evidence in Aster

- `project-render-boundaries.ts:9` requests a surface only for a 3D wrapper or enabled wrapper
  effects. An ordinary 2D precomposition is expanded into its parent by `scene-evaluation.ts:109`.
- `scene-camera.ts:10` selects the camera from the composition being rendered. Geometry filters
  camera layers out of drawable batches; merely expanding a child camera does not activate it.
- `precomposition-surface-renderer.ts:318` already evaluates the source camera at the mapped source
  time. The isolated path provides a usable foundation for the fix.
- `precomposition.ts:78` makes wrappers 3D to isolate adjustments and generators. This conflates
  spatial behavior with a render boundary.
- `precomposition-time.test.ts` verifies camera settings and transforms, but not their effect on
  rendered geometry. This explains why parameter preservation tests can pass with the visible bug.

A temporary executable probe precomposed a mesh and a camera with animated Y rotation. At 0 and 2
seconds the child geometry differed, while the parent geometry was identical. The probe passed and
was removed. The related test invocation passed 121 tests across 15 files. This is evaluator-level
evidence, not a GPU pixel comparison or a test of the proposed implementation.

## Reference behavior and Aster contract

Adobe documents ordinary nesting as a rendered image boundary, and Collapse Transformations as
exposing nested 3D content to the containing composition's camera and lights. It also documents
exceptions that introduce intermediate compositing for effects, masks, and adjustments. See
[Adobe: precomposing and nesting](https://helpx.adobe.com/after-effects/desktop/work-with-compositions/precomposing-and-nesting/precomposing-nesting-pre-rendering.html).
The active camera supplies the view for nesting and final output; without one, the composition's
default view applies. See [Adobe: cameras](https://helpx.adobe.com/after-effects/desktop/work-with-layers/camera-layer/cameras-lights-points-interest.html).

The following is the proposed Aster contract, using those rules as the reference:

| Behavior | Ordinary precomposition, default | Collapse Transformations enabled |
| --- | --- | --- |
| Camera | Source composition's active camera at source time | Containing render scope's active camera at that scope's time |
| Child camera | Controls the source's 3D content | Does not become the containing scope's camera |
| Lights | Local to the source render | Use the containing scope; do not leak child lights into it |
| 3D geometry | Rendered into a flat image before parent composition | Remains geometry in the containing render scope |
| Child frame boundary | Clips source output | Does not itself crop expanded geometry |
| Interaction with parent 3D layers | Internal depth remains isolated | Eligible to share depth and shadows, subject to stack boundaries |
| Wrapper 3D switch | Makes the resulting image a 3D plane | Controls wrapper spatial transforms independently of collapse |

Thus a 2D ordinary wrapper preserves the child camera while ignoring the parent camera. A 3D
ordinary wrapper first renders through the child camera, then places that image in the parent's
3D scene. Two ordinary child compositions can use different cameras simultaneously.

For multiple nesting levels, the relevant parent camera belongs to the nearest containing render
scope. It is not necessarily the project's top-level composition. A camera affects eligible 3D
content; this fix must not make ordinary 2D artwork respond to camera movement.

## Data and evaluation changes

1. Add a persisted, non-animated `collapseTransformations` boolean for precomposition layers.
   Default it to `false`. Expose a single Collapse Transformations switch, separate from the 3D
   switch, with undo/redo and serialization support.
2. Make ordinary nesting establish a source render boundary regardless of cameras, effects, or
   wrapper dimensionality. Do not use camera presence or current camera activity to switch render
   paths: doing so can change cropping, blending, and depth at a camera cut.
3. Keep `evaluateLayerSourceTime` as the source of time mapping. At each boundary, evaluate source
   layers, camera transforms and parents, camera properties, and camera selection at the same
   mapped time. Wrapper transforms and effects remain evaluated at the wrapper's parent time.
   Preserve offsets, stretch, remapping, half-open cuts, reverse seeking, and out-of-order evaluation.
4. For collapsed nesting, expand eligible child content into the containing scope and exclude child
   cameras and lights from that scope's camera/light selection. Use proper matrix composition for
   3D transforms; the existing Z-rotation-oriented `mapNestedTransform` is not sufficient for general
   collapsed 3D hierarchies with X/Y rotation and nonuniform scale. Reuse existing math where possible.
5. Separate camera scope from temporary surface allocation. A collapsed group may need an effect
   intermediate while still using the containing camera. Do not implement this as simply
   `!collapseTransformations || hasEffects` followed by the current source-camera surface path.
   Preserve the containing camera, viewport, accumulated transform, and source evaluation time in
   that case. Nested adjustments must retain their composition-local stack scope.
6. Update shared render-boundary validation and all callers, including precompose creation and
   project loading. Remove the need to force new adjustment/generator wrappers to 3D merely to
   obtain isolation. A newly created wrapper remains spatially neutral and untinted.

No camera duplication, keyframe baking, playback-only propagation, or new animation engine is
required. Preview, seeking, still export, and background output must use the same evaluator.

## GPU rendering and limits

Reuse the existing GPU surface renderer, dependency ordering, and texture reuse. Ordinary source
surfaces remain GPU-resident. Share source renders only when composition revision, mapped time,
resolution, and render settings match. A collapsed effect intermediate is parent-dependent and
must also distinguish the containing view and accumulated transform; the current source-only key
cannot safely identify it.

Making isolation the default exposes existing limits: four surfaces, four nesting levels, texture
and pixel budgets, and a bounded byte budget. A fifth valid child must not disappear. Before broad
rollout, replace the small surface-count/depth limits as normal scene limits with dependency-aware
lifetime reuse and bounded memory planning. Keep cycle detection and a defensive recursion limit.
Do not overwrite a texture while an unconsumed parent still needs it. Preview can lower resolution
with a visible diagnostic; if required targets still cannot be allocated, report failure rather than
rendering incomplete content. Exact output must either render the requested frame or fail explicitly.

The existing source surface path does not run the root camera depth-of-field pass, general scene
motion blur, child shadow maps, HDR environment sampling, or mesh normal-map sampling. It does have
a text motion-blur path. Recovering camera movement alone does not establish full source-view parity.
Reuse the relevant existing composition passes through a small shared composition-rendering unit,
with explicit targets and camera scope, rather than copying the entire root renderer. Apply child
camera postprocessing before compositing its ordinary wrapper into the parent. Unsupported combinations
must remain explicit until completed; do not advertise complete AE renderer parity.

## Project compatibility

Recommend schema v11 because the persisted flag controls visible rendering and older builds cannot
honor it. Update frontend migration/validation and the native editor-document version gate together.
Migrate missing flags to `false`, so existing camera compositions receive the fix automatically.
Preserve persisted wrapper transforms, 3D flags, colors, and time mappings; historical intent cannot
be inferred reliably enough to rewrite them.

This intentionally corrects legacy implicit expansion. Old scenes that relied on parent cameras,
out-of-bounds child content, or cross-boundary blending may change. Record that behavior in upgrade
notes and provide explicit Collapse Transformations for intended parent-space composition. Do not
claim that enabling it reproduces every legacy pixel: the old path was not a complete collapse model.
Opening a project should migrate its in-memory copy, with disk persistence following normal save.

## Implementation sequence

1. Add a permanent failing camera-projection regression and specify ordinary/collapsed behavior.
2. Add the schema field, migration, validation, and independent UI control. Route ordinary sources
   through their own camera/time context and remove isolation-driven 3D defaults.
3. Implement collapsed camera/light scope and matrix composition, including effects/adjustment
   boundaries. Verify mixed ordinary/collapsed nesting rather than assuming all ancestors collapse.
4. Complete source-render parity and resource planning needed for default isolation. Keep modules
   cohesive; avoid adding the entire implementation to the root renderer or surface renderer.
5. Verify production pixels and budgets, then update architecture, project format, performance
   methodology, and AE workflow documentation. No plugin ABI change is expected for the basic fix;
   verify generators receive the correct existing camera/time inputs.

These steps describe implementation order, not permission to ship an incomplete collapse switch or
silently omit unsupported source passes. Camera projection recovery can be verified early, while
the broader compatibility claim depends on the remaining acceptance checks.

## Acceptance checks

| Case | Required result |
| --- | --- |
| Animated position, rotation, point of interest, zoom | Ordinary nested output follows the child camera at several sample times |
| Parent and child both have cameras; two different child cameras | Each ordinary child preserves its own view; parent movement affects only eligible wrappers/content |
| Camera cuts, gaps, disabled cameras | Source active-camera/default-camera selection; no change of isolation policy |
| Trim, offset, stretch, remap, reverse and random seek | Same mapped-time camera and pixels as direct source evaluation |
| 2D wrapper and 3D wrapper | Image-space composition versus a projected plane, without unintended double projection |
| Collapse on/off; mixed nesting | Camera/light ownership follows the nearest render boundary |
| X/Y/Z rotation, parenting, negative/nonuniform scale | Correct composed geometry under collapse |
| Wrapper effects, alpha, cropping, adjustments, 2D overlays | Correct local stack and depth boundaries; no camera ownership change caused by an effect |
| DOF, motion blur, shadows, environments, normal maps | Declared source-view parity or an explicit unsupported result |
| Five small children and more than four nested levels | Complete output when within budget; no arbitrary missing layer |
| Repeated source at same/different times | Safe sharing only for equivalent render inputs; bounded allocations |
| Save/reopen, old-project migration, undo/redo | Stable persisted mode and source timing |
| Viewport, still and background export | Equivalent output at the same time and production settings |

Use deterministic GPU image comparisons for the identity-wrapper camera cases, in addition to
evaluator and mocked-GPU tests. Compare ordinary nested frames against direct source renders with
the same resolution, color pipeline, transparent background, and neutral wrapper. Record tolerance
for the additional texture sampling pass. Measure frame-time percentiles, resident GPU bytes, render
pass count, and texture allocations on representative nested scenes; internal rendering must add
no CPU frame readback.

During implementation run repository checks through lefthook: staged Biome checks, frontend tests
and typechecking, and relevant Rust formatting/Clippy/tests for the schema gate. Run the relevant
frontend and desktop build before declaring the implementation complete. This proposal itself
changes no runtime code and has not run a production build or AE/GPU visual comparison.
