# Automation keyframe interpolation

MCP and built-in agent transform commands also accept `anchor.0`, `anchor.1`, and
`anchor.2`. This exposes the existing editable pivot tracks for mesh joints and
off-center rotation. Values use layer-local pixels and do not compensate position;
set the position separately when moving a pivot while keeping geometry in place.
Static values, keyframes and expressions use the ordinary timeline, Inspector,
undo and render paths. No project-format or plugin-ABI change, GPU pass or readback
is added. `anchor-animation.test.ts` checks independent axes, non-monotonic seeks,
source isolation and invalid-axis rejection.

The `addKeyframe` AI command accepts optional `interpolation` (`linear`, `step`, or
`bezier`) and `easing` (four numbers in the interval 0–1). This applies to the
built-in agent and external MCP clients through the shared command registry.

Omitting both fields preserves the original bezier ease-out `[0.16, 1, 0.3, 1]`.
Linear keys produce uniform movement; step keys hold until the next keyframe.
Easing is stored only for bezier keys. Invalid modes or malformed curves are
rejected before the staged project is mutated.

```json
{
  "type": "addKeyframe",
  "layerId": "existing-layer-id",
  "path": "position.0",
  "time": 0,
  "value": 640,
  "interpolation": "linear"
}
```

These commands create ordinary project keyframes: the existing graph editor,
undo transactions, persistence, preview and export all use the same data. No
project format migration, plugin ABI changes, GPU readbacks or new per-frame
allocations are introduced. Evaluation retains the existing binary search over
sorted keyframes and works independently of playback history.

`src/ai/keyframe-interpolation.test.ts` checks uniform motion at non-monotonic
sample times, a hold immediately before and at its boundary, custom easing,
legacy defaults, invalid input, and source-project isolation. This is a functional
regression test, not a performance benchmark.

## Reconstruction rendering and persistence

Advanced SVG, PSD and image-sequence imports start with a neutral white tint so
source colors survive compositing. Existing projects keep their authored tints.
Two-dimensional solid layers use the analytic rectangle shader, with pixel-scale
edge antialiasing instead of the generic quad's 2.5% feather. Three-dimensional
solid lighting retains its existing path. Neither fix adds GPU passes or readbacks.

Atomic transactions over 100 operations retain a bounded type summary and omit
replay JSON. The live operation transaction and undo history are unchanged; saved
projects stay within the existing manifest limit. See `PROJECT_FORMAT.md`.

Vitest excludes generated `artifacts` and `artifacts-final` directories, matching
the repository's artifact policy and avoiding duplicate tests from validation
checkouts. Source tests and separate packaging checks continue to run via lefthook.

Effect queries now enumerate the active composition independently of the current
selection. They return bounded parameter metadata without LUT voxel arrays and
skip unnecessary scene evaluation. Pagination retains the normal query contract.

Native inline media validates base64 length against its already bounded declared
byte count before decoding. The generic metadata string cap no longer rejects
legitimate SVG/PSD/image payloads. Decoded length and content identity are still
checked, and existing per-media and bundle budgets remain in force.
