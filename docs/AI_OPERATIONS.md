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

Supported frontend operations include property changes, keyframes, layer creation/removal/reorder,
rename, effect creation/removal/parameters, and layer switches. Native schemas are generated with
`schemars` to prevent prompt/documentation drift.

Provider keys are accepted in memory or through `ASTER_AI_API_KEY`. HTTPS is required except for
localhost development. Errors redact credentials and response bodies are size/time bounded.
