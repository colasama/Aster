Goal: complete the Aster Rust renderer migration defined in
`docs/migration/RUST_RENDERER_MIGRATION.md`, on branch `feature/rust-renderer`.

Owner overrides (2026-10-04, Asia/Tokyo): use Chinese throughout the work. The owner permits
validation on the current local Ryzen 7 8745H / Radeon 780M / Windows 10 machine; establish a
separate performance baseline series instead of reusing RTX 5060 measurements. The updated goal
supersedes the stop-on-blocker instructions below and in the specification: record obstacles and
evidence, resolve them or continue independent required work, and pursue all milestones. A failed
or skipped gate remains failed or skipped; full-gate commit requirements, pixel self-review and
the definition of done are unchanged. These overrides are also recorded in the progress ledger.

Follow the specification's section 8 ("The loop protocol") in every cycle, together with
`AGENTS.md`, `crates/AGENTS.md`, and `DEPENDENCY_POLICY.md`.

- The ledger `docs/migration/rust-renderer-progress.json` is the source of truth. Read it and the
  newest `artifacts/migration/verify-*.json` at the start of each cycle; do not rely on conversation
  memory.
- If the ledger `status` is `blocked` or `done`, stop and report.
- Accept or reject every non-exact pixel result yourself through the section 6.6 self-review; never
  wait for a human visual sign-off.
- Work on the active milestone's first open task. Make the smallest increment that moves a required
  gate toward green. Verify with `pnpm migrate:verify --milestone <id>`. During M0, before that
  command exists, run the individual G0 commands from section 6.5.
- The owner performance project is `D:\code\SD04PV`; set `ASTER_PERF_PROJECT` to it when it is not
  already set.
- Commit only when the full required gates are green (gitmoji, architectural intent in the body).
- At the end of each cycle, update `last_cycle` and the task and milestone state in the ledger, and
  commit the ledger update. Never leave uncommitted changes that break G0.
- Escalate per section 10 by setting `status` and `escalation` with evidence and a concrete
  question, then stop.

The goal is achieved when the specification's section 11 ("Definition of done") holds.
