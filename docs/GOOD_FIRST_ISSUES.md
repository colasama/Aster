# Good first issues

These tasks are intentionally bounded, testable, and avoid renderer architecture changes. Before
opening one, confirm the checkbox is still unclaimed in the linked issue tracker.

## Add keyboard focus tests for one dialog

- Scope: one component under `src/components/` and a colocated test.
- Acceptance: initial focus, Escape close, and focus restoration are asserted without snapshots.
- Validation: `pnpm check:frontend`.
- Avoid: global shortcut or panel-layout changes.

## Add a project-boundary rejection fixture

- Scope: `src/core/project-file.test.ts` only.
- Acceptance: one malformed current-schema document is rejected with a stable, useful error and the
  input object remains unchanged.
- Validation: `pnpm exec vitest run src/core/project-file.test.ts`.
- Avoid: adding legacy migrations; the MVP accepts only the current schema.

## Add one WGSL effect example

- Scope: one directory under `examples/plugins/` containing `plugin.toml` and `effect.wgsl`, plus the
  example-name list in the plugin conformance test.
- Acceptance: the shader implements ABI v1, declares bounded parameters, and passes Naga validation.
- Validation: `cargo test -p aster-plugin bundled_effect_examples_implement_the_v1_abi`.
- Avoid: native code, network access, or undeclared files.

## Improve one Inspector label or unit

- Scope: one built-in effect definition and its registry test.
- Acceptance: the label/unit is unambiguous, parameter bounds remain unchanged, and search still finds
  the effect by its common name.
- Validation: `pnpm check:frontend`.
- Avoid: changing rendered pixels.

## Document one reproducible GPU benchmark result

- Scope: `docs/BENCHMARKS.md` and no source code.
- Acceptance: record exact commit, OS, GPU/driver, resolution, scenario, preview quality, warm-up count,
  median frame time, and whether timestamp queries were available.
- Validation: Markdown links and table render correctly.
- Avoid: comparing results collected with different project fixtures or quality settings.

Maintainers should label accepted issues `good first issue` and `help wanted`, assign one mentor, and
keep architectural follow-ups separate. If investigation reveals a broader change, preserve the
original bounded issue and open a new design discussion.
