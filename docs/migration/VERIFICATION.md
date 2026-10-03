# Renderer migration verification

The progress ledger identifies the active task and approved reference source. Run commands from the
repository root on `feature/rust-renderer`. Preserve an existing `ASTER_PERF_PROJECT`; otherwise set it
to the owner's project directory (`D:\code\SD04PV` on the authorized local Windows host).

`pnpm migrate:verify --milestone M0` runs the complete static and Electron application checks. During
the M0 exit task it also audits the reference corpus, deliberately rejected oracle probe, committed
performance baseline, and whole-corpus TS exact comparison. A failed exit audit returns a nonzero
status while retaining the actual individual gate results. `--quick` never establishes milestone
completion.

## Preserving the pixel oracle

The original M0 reference remains in `artifacts/parity/reference/`, pinned by
`reference_baseline.renderer_source_sha256` in the ledger. Explicit `reference_repairs` may overlay
individual requested frames during M0 after section 6.6 self-review. Each overlay retains its real
capture source and evidence; it does not rewrite original files or sequence neighbors. The normal
`parity:capture` command creates or refreshes references; do not use it to test a changed renderer
against an existing baseline.

1. Run `pnpm parity:capture --candidate` to capture the current production TS renderer into a separate
   run directory. This bypasses reference caching and never publishes into the reference directory.
2. Run `pnpm parity:check-ts --candidates <candidate-manifest-path>` using the manifest reported by
   the capture. This invokes the real comparison CLI with `exact` for every required corpus frame.
   It does not capture or modify references.
3. Record the capture report, manifest and exact report paths in the M0 exit task's `exit_evidence`
   (`candidateCaptureReportPath`, `candidateManifestPath`, `exactReportPath`), then run the full
   migration verification command. The audit checks their underlying files and source bindings.

Keep source files unchanged while capture, comparison or gate execution is running. Candidate output
contains the requested frames and any sequence neighbors. Full G3 comparison covers the requested
addresses; it does not authorize promotion of additional neighbor frames into a new reference set.
The effective reference set must be fixed before M1. Each repaired frame must come from a separate
capture run from the candidate used to prove exact parity; comparing a capture to itself is invalid.
The original particle oracle used atomic append order, which could change transparent blending and
mesh occlusion between identical evaluations. M0 fixes the general ordering defect and records one
reviewed billboard-frame repair. Failed comparisons against the original remain failed. The M1/M2
exact thresholds are unchanged.

## Performance evidence

`pnpm migrate:benchmark` measures the full warm-up and three-run workload schedule described in
`docs/BENCHMARKS.md`. Scope options such as `--smoke` are diagnostic and cannot replace the baseline.
The committed local Radeon 780M series is independent of historical NVIDIA results. Missing GPU
timing or encoder capabilities remain explicit limitations, never fabricated measurements.

Generated evidence is stored under ignored `artifacts/`; hashes and paths in the ledger identify the
actual runs. Preserve these files when continuing on the same host. A missing or modified evidence
file must fail verification rather than being accepted from a previous status string.
