# AI operation API

AI is an operator, not an alternate mutation path. Providers return an `OperationPlan` containing a
summary, risk level, required permissions, and a list of typed project operations.

## Lifecycle

1. Capture only the project context required by the prompt.
2. Send it through a configured provider boundary.
3. Parse strict JSON and reject unknown operations or out-of-scope IDs.
4. Check plan permissions against the caller grant.
5. Preview a deterministic diff.
6. Apply the whole plan as one undoable transaction after explicit acceptance.
7. Append a secret-free audit record.

The MVP exposes exactly these provider-callable operations. Everything else remains a user-only
editor operation until it has an explicit normalizer and permission review.

| Operation | Required fields | Result |
| --- | --- | --- |
| `addLayer` | `kind`; optional `name`, `text` | Creates a supported layer at the current time. |
| `removeLayer` | `layerId` | Removes an existing layer through the undo transaction. |
| `renameLayer` | `layerId`, `name` | Renames an existing layer. |
| `reorderLayer` | `layerId`, `index` | Moves a layer to a bounded stack index. |
| `toggleLayer` | `layerId`, `field` | Toggles visibility, solo, lock, audio, or 3D state. |
| `setProperty` | `layerId`, `path`, `value` | Sets a finite transform property. |
| `addKeyframe` | `layerId`, `path`, `time`, `value` | Inserts an editable Bezier keyframe. |
| `addEffect` | `layerId`, `effectType`; optional parameters | Creates a registered GPU effect. |
| `removeEffect` | `layerId`, `effectId` | Removes an effect owned by the target layer. |
| `setEffectParameter` | `layerId`, `effectId`, `parameter`, `value` | Sets a finite parameter on an owned effect. |
| `setTextAnimator` | `layerId`; optional animator fields | Enables and configures bounded per-character delay, transform, and opacity. |

The public `AI_OPERATION_TYPES` catalog drives both the provider system prompt and the function-tool
enum, preventing those boundaries from drifting. The frontend still normalizes IDs, property paths,
layer kinds, effect ownership, finite numbers, and bounds before a preview can be accepted. Native
domain schemas are generated with `schemars` for permission-checked core transactions.

Provider keys are accepted in memory or through `ASTER_AI_API_KEY`. HTTPS is required except for
localhost development. Errors redact credentials and response bodies are size/time bounded.
