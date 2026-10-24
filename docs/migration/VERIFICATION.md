# Renderer migration verification

The progress ledger identifies the active task and approved reference source. Run commands from the
repository root on `feature/rust-renderer`. Preserve an existing `ASTER_PERF_PROJECT`; otherwise set it
to the owner's project directory (`D:\code\SD04PV` on the authorized local Windows host).

Current final delivery uses `pnpm migrate:verify --milestone M12`. G1/G2 execute authored projects
in Rust; G3 requires both complete project and native preview pixels; G4 combines four balanced
export pairs with three preview pairs and independent latency; G5 checks complete project exports;
G6 exercises production-default packaged applications and verifies renderer retirement. The exit
audit runs when M12-T9 is active and requires T1–T8 complete, current full G0–G6, authenticated
self-reviews and hash-pinned delivery documentation. Development commits use full G0 plus affected
checks and cannot establish this final result. The earlier milestone procedures below preserve their
historical boundaries; references to TS production capture describe the retained reference program.

`pnpm migrate:verify --milestone M0` runs the complete static and Electron application checks. During
the M0 exit task it also audits the reference corpus, deliberately rejected oracle probe, committed
performance baseline, and whole-corpus TS exact comparison. A failed exit audit returns a nonzero
status while retaining the actual individual gate results. `--quick` never establishes milestone
completion.

Each static-check invocation needs a fresh output directory. An existing `static-results.json`
causes rejection before checks run, preserving the previous aggregate and its log bindings.

## Preserving the pixel oracle

The original M0 reference remains in `artifacts/parity/reference/`, pinned by
`reference_baseline.renderer_source_sha256` in the ledger. Explicit `reference_repairs` may overlay
individual requested frames during M0 after section 6.6 self-review. Each overlay retains its real
capture source and evidence; it does not rewrite original files or sequence neighbors. The normal
`parity:capture` command creates or refreshes references; do not use it to test a changed renderer
against an existing baseline.

The owner's 2026-10-15 material-readiness correction authorizes only frame 0 of the directional,
point and spot lighting cases. The scoped candidate manifest and capture report are hash-pinned;
their corrected raw pixels must match the approved proposal, and the nine later frames must still
match the originals. The material repair auditor preserves the original rejected comparisons.
Native scene and NV12 replay use the corresponding corrected first-frame plans and resources;
all other supplied plans remain bound to the original input manifest. This correction does not
change numerical tolerances or permit other structural reference substitutions.

G5's authorized `encoded-preencode-structural-witness-v1` path preserves the raw encoded verdict.
Eligible failures trigger separate native RGB, independent BT.709 NV12 and decoded pre-encode
comparisons for the same case and frames. Checkpoint recovery authenticates the execution source,
native binary, supplied plans/resources and effective reference binding across these stages.
Only ink bounds and explicitly indeterminate registration can use the witness; measured shifts
above 0.25 px and other encoded check failures remain failures. Every witness comparison requires
its ordinary self-review, followed by a separate encoded review with this policy as `purpose` and
the exact witness report hash in `layered_evidence`. Old failed reports and flat rejected reviews
remain intact. A missing review cannot yield an accepted layered frame.

1. Run `pnpm parity:capture --candidate` to capture the current production TS renderer into a separate
   run directory. This bypasses reference caching and never publishes into the reference directory.
2. Run `pnpm parity:check-ts --candidates <candidate-manifest-path>` using the manifest reported by
   the capture. This invokes the real comparison CLI with `exact` for every required corpus frame.
   It does not capture or modify references.
3. Record the capture report, manifest and exact report paths in the M0 exit task's `exit_evidence`
   (`candidateCaptureReportPath`, `candidateManifestPath`, `exactReportPath`), then run the full
   migration verification command. The audit checks their underlying files and source bindings.

Diagnostic capture accepts `--timeout-ms` from 1,000 to 1,200,000 per case. Long sequences that
capture resources and independently replay every frame can require more than ten minutes. A timeout
remains a failed run; retry with an explicit larger deadline without changing pixel acceptance.

Keep source files unchanged while capture, comparison or gate execution is running. Candidate output
contains the requested frames and any sequence neighbors. Full G3 comparison covers the requested
addresses; it does not authorize promotion of additional neighbor frames into a new reference set.
The renderer fingerprint hashes existing source bytes independently of Git staging. Removed tracked
files leave that content set; the full-tree provenance also records unstaged deletions explicitly.
The effective reference set must be fixed before M1. Each repaired frame must come from a separate
capture run from the candidate used to prove exact parity; comparing a capture to itself is invalid.
The original particle oracle used atomic append order, which could change transparent blending and
mesh occlusion between identical evaluations. M0 fixes the general ordering defect and records one
reviewed billboard-frame repair. Failed comparisons against the original remain failed. The M1/M2
exact thresholds are unchanged.

Comparison artifacts are published as one complete directory under a create-new lock. On Windows,
only the final directory rename retries access/sharing errors (OS codes 5, 32 and 33). The CLI defaults
to five attempts with a 20 ms initial exponential delay, retaining the complete staging directory and
checking that the destination remains absent before every attempt. The configurable bounds permit
at most five attempts and a 50 ms initial delay. Other I/O failures and exhausted retries fail the
comparison with operation/path context; they never count as accepted pixels or reuse partial output.

Phase registration preserves its initial estimate whenever it is observable. An indeterminate
estimate retries with half the boundary taper and one tenth of the relative spectral floor, retaining
the same signal and confidence requirements. This recovers distinguishing weak features and clipped
edge content. The retry also requires an untapered estimate to agree within two subpixel sampling
steps; otherwise registration remains indeterminate. The report records this disagreement and uses
the untapered shift. Pixel inputs are never aligned, and profile translation limits remain unchanged.

Sparse features can have reliable local contrast while their full-frame RMS falls below one code
value. A conservative recovery requires at least 32 non-background pixels in each image, occupying
at most 0.1% of that image, and support RMS of at least one code value. The background occupancy is
checked exhaustively; no pixels are removed or replaced. Both half-tapered and untapered phase
estimates must pass the existing spectral, axis and peak checks, achieve coherence of at least 0.95,
and agree within two sampling steps. Reports include the support measurements. Uniform references,
weak dense contrast and clipped features without agreeing estimates remain indeterminate. Synthetic
continuous-space controls test shifts on both sides of the unchanged 0.25-pixel limit.

## Shared-shader increments

M1 shares output AA, core scene variants, compositing, fused post-processing, blur/depth/surface
effects, auxiliary surfaces, particles, text motion blur, display/buffer helpers and generator/audio
ABI declarations in `shaders/`. The TS catalog loads raw WGSL through Vite, and `aster-shaders`
embeds the same files and validates the manifest's assembled programs with Naga. Fragment order,
entry points and typed pipeline overrides come from `shaders/manifest.json`. Fixed unsigned integer recipe items
preserve the existing shader-creation layout constants without expression evaluation. Original
expanded-source hashes protect both scene variants and the static helpers; lighting uniform size
remains 592 bytes for eight lights. Helper modules without entry points are still Naga-validated.
Motion blur replaces only its four fixed tile-size insertions with a typed WGSL override. Its
16-pixel default also controls host allocation; restoring those four literals and removing the
override declaration must reproduce the original source hash. Whole-corpus exact G3 validates the
resulting pipeline output.

The fused post-process recipe owns the warp and pixel case order, dependent helpers and exact
fragment boundaries. Its root-only `root_zero_operations` specialization follows the validated
zero-operation upload contract; the default remains dynamic for layer effects. Tests pin the full
assembled source and check the production pipeline's specialization. Rust validates the complete
assembled program with Naga; switch-case
fragments cannot be validated as independent modules. Tests also retain the eight binding slots,
host layouts, entry points and typed override default. Whole-corpus exact G3 remains required.

The generator, audio, text and diagnostic programs retain their original expanded-source hashes.
Scene-generator context, parameter, particle and audio buffer layouts remain unchanged; the audio
arrays have fixed ABI lengths, not pipeline overrides. A direct raw import keeps the CPU audio
module independent of the renderer catalog.

For each M1 increment, freeze the source tree, run `pnpm parity:capture --candidate` for the full
corpus, then run `pnpm migrate:verify --milestone M1 --candidates <candidate-manifest-path>`.
The ledger's `active_candidate_manifest` supplies that path when `--candidates` is omitted.
G3 audits the full capture report and frame provenance against the current renderer source before
requiring exact pixels for every requested frame. A previous capture from different renderer sources or
a diagnostic subset cannot satisfy this gate. Comparison never creates or refreshes references.

The M1 ledger's `frozen_reference` must equal the completed M0 effective reference binding, including
the original source pin and the exact reviewed repair set. Neither that binding nor the repair set
may change to accommodate shader extraction. Passing G0/G3 for one task establishes that increment
only. The original reference files must also retain the aggregate digest recorded by the completed
M0 verification, and candidate project, media, plugin and frame inputs must match those references.
M1 exit additionally requires every shader to be shared and Naga-valid, the enforced absence of
WGSL string literals throughout `src/`, and the remaining section 5 work.

When `M1-T6` is active or complete, a full M1 run also performs the shared-source exit audit.
The AST scan reads every TS/TSX source file, including tests, and rejects marked or unmarked inline
WGSL implementations and literal-derived shader compiler inputs. Short syntax assertions and
non-WGSL mock values are classified separately. Disk WGSL paths must exactly match the manifest,
all fragments must be used, and Rust tests compare the embedded files with the same disk sources
before validating all assembled programs with Naga.

The effect-shot harness writes only compiled operation data and shader digests. Its registered
effect types must match the canonical effect cases in the parity corpus. The exit run creates a
fresh manifest, runs the native `effect_shots` example with the shared catalog, and audits every PNG
and the native report before publishing its output directory. This is a native shader smoke test;
it does not compare default-parameter diagnostic images with the richer corpus reference images or
replace native effect parity in M4. Current full TS exact G3 remains the M1 pixel gate.

The exit audit binds the source inventory, current G0/Naga results, current full exact G3 and native
shader smoke to one source tree. Quick checks, stale evidence, missing prerequisites, incomplete
coverage or failed output audits cannot establish M1 completion.

## Frame-plan transport and consumption

Under the approved `rust-delivery-v1` policy, M2 requires G0, G1 and G3; performance observations
do not block TS plan extraction. The runner rejects a ledger gate list that omits or duplicates a
required gate. Full G1 regenerates the Rust-owned schema into a fresh output and runs actual
TS-to-Rust-to-TS canonical FPLN round trips. Expected schema bytes are never overwritten during
verification. Container boundaries, resource hashes and budgets have separate negative tests.
Root producer fixtures also round-trip signed zero, subnormal and extreme finite times, fractional
seek requests and exact decimal-rate metadata. Their decoded time bits and actual supplied uniform
uploads are checked independently of the original request.
Scene-buffer fixtures add nested composition, camera, mesh, lighting and motion payloads plus empty
geometry. G1 round-trips them through Rust and checks decoded uploads and shadow ranges. Mutation
tests verify producer ownership, borrowed unaligned views and destination replacement on resizing.
Evaluated camera fixtures cover nested perspective and orthographic cameras with exact f64 payloads.
Their decoded pose, projection and optics match TS evaluation; consumer tests compare geometry,
lighting, generator context and depth uniforms and verify that changed supplied bytes alter geometry.
Media lease tests exercise atomic acquisition, changed-source/frame rejection, abort and delayed GPU
completion across cache destruction, including the shared placeholder owner. Full G3 remains required
for media draw adapter changes; these lease tests alone do not establish content-addressed replay.
G1 also sends image/sequence/video/raster resource messages through the Rust CLI registry and back to TS,
checking exact descriptor hashes, requested/uploaded time values and ordered eviction. Wrong hashes,
kind mismatches, missing sources and premature source eviction must fail. Registry tests cover
exact text/SVG/PSD raster bounds, including signed zero and fractional values; nonfinite bounds must
be rejected before registry admission. Ordinary text upload tests check stable retained generations
and stale lease rejection after changed font/source uploads. Registry tests also cover
descriptor budgets, ownership across asynchronous hashing and in-flight frame/source dependencies.
Production adapter tests validate installed still extents after bitmap closure, resolved sequence
members, actual video upload times, and drawing by supplied hash independently of instance IDs.
G1 round-trips temporal text samples from the actual shutter planner for full, entering and exiting
exposure. It also admits five packed texture resources through Rust: identity/custom 3D LUTs,
linear RGBA8 normal texels, RGBA16F HDR texels, and an actual two-row Radiance decode with worker
padding removed. The decoded descriptors and pixels drive recorded
production GPU uploads with exact format, extent and row/layer layout. Both registries reject
corrupted pixels; upload tests reject descriptor/hash corruption before allocation.
The identity/custom LUT fixtures originate in the production selection planner. Selection tests
cover last-enabled-loaded precedence, owned bytes after authoring mutation, source-key reuse and
eviction. Effect consumer tests upload a cloned selection after its authored LUT changes, reuse an
unchanged hash without another upload, and destroy replaced/swept GPU owners. Root and precomposition
adapters are exercised by full G3, including nonlinear trilinear/tetrahedral LUT corpus cases.
Material tests
mutate authoring inputs after preparation, check supplied uniforms and pending fallback behavior,
reject retired generations, and retire a normal upload while GPU validation is pending.
G1 transports five material binding slices through Rust: inactive, normal-only, environment-only,
combined and exact-bit scalars. Decoded binary64 values, tagged texture hashes, UTF-16 instance
identities and production float32 uniforms must match exactly. A hash registry resolves decoded
references independently of authoring IDs and rejects missing or wrong-role owners. These checks
establish binding transport; they do not establish complete material shader draw replay.
G3 also verifies PNG/JPEG/WebP normal uploads outside the legacy scene corpus. A pinned legacy
uploader records actual linear RGBA8 texture bytes, then its GPU device and page are destroyed.
Encoded resource messages and payloads pass through Rust before a new page/device decodes and uploads
them. Every replay texel must match exactly; the consumer never receives reference pixels. The gate
audits saved payload hashes, Rust-returned messages and both pixel buffers. This verifies normal
resource upload. A separate required material-draw audit transports one scene and six material plans
through Rust together with encoded normal and packed HDR resources. The original page/device is
destroyed before the production GPU binding consumer replays only the supplied data. Inactive,
normal, negative normal scale, environment, rotated environment and combined draws compare exactly
against separately frozen 64x48 RGBA16F buffers. The reference uses the pre-extraction binding logic,
direct evaluated scene buffers, legacy normal upload and padded decoded HDR pixels. All six outputs
must differ and contain visible geometry. The audit pins the reference implementation and buffers,
verifies seven exact FPLN round trips and both resource hashes, and compares saved GPU output bytes.
This is material draw coverage, not complete captured-frame replay.
Temporal sample fixtures cover full, entering and exiting
exposure, plus transparent and exact-bit fixtures. Supplied samples and exposure identities must
survive Rust decoding and TS cloning; invalid formats, frame time, weights and sample lanes fail.
G1 additionally transports hash-addressed accumulation/resolve plans through Rust in four fixtures:
full exposure, partial exposure, transparent-only and exact-bit weights (including negative zero
and a subnormal). Reconstructed ordered hashes drive recorded draw bindings and reconstructed f64
weights drive the final f32 uniform writes. TS and Rust reject malformed dependency/exposure inputs.
G3 captures the production pass slice and individual sampled rasters before submission cleanup.
It round-trips the captured FPLN through Rust and loads a separate replay page after destroying the
original device. That consumer imports no authoring evaluators and receives no resolved output
pixels: it uploads decoded samples into new allocations and executes supplied accumulation/resolve.
Saved sample payloads, resource dependencies, FPLN bytes and independent GPU output are audited;
any missing or changed evidence fails the gate. Complete submitted-frame replay remains open.
The temporal upload boundary test revokes authoring-layer access and mutates original samples after
acquisition, then checks that uploads retain the acquired canvases and copied weights. The pass
executor test discards producer weights and executes a cloned plan with an independently changed
weight. Extent, output binding, sample slot, missing resource, uniform storage and duplicate hash
errors must fail before any GPU write or render pass.
Malformed prepared extents or sample counts must fail before GPU allocation. Full G3 still verifies
the production cache, accumulation and resolve path against exact reference pixels.
Temporal output lifetime tests register actual cache owners by hash, retain two generations, and
verify old bindings survive replacement and cache destruction until release. Retired pinned outputs
remain budgeted, unchanged pinned generations remain reusable, and switching to ordinary text cannot
reuse a retired texture. Resolved temporal outputs also enter the real raster GPU capture/replay audit.
M2 G3 additionally runs a hidden GPU window for full, entering, exiting and transparent temporal
glyph exposure. These four resolved outputs use separate frozen exact PNG references, established
by comparing the pre-cycle-31 cache to its replacement on the same device. The ledger pins their
manifest; verification never regenerates them. The gate checks canonical sample counts, dimensions,
exact pixels, independent GPU resource replay and Rust resource admission. Its failure fails G3.
This closes a coverage gap in the original scene-motion-blur fixture, which disables text animators
and therefore exercises layer movement rather than temporal glyph accumulation. The original 337-case
corpus and references remain unchanged; these four output checks do not claim complete frame replay.

G1 also round-trips text/SVG/PSD scene slices built by the production geometry producer, then joins
the returned geometry with independently admitted Rust resource transcripts and binary pixels.
The original geometry and authoring scenes are discarded before the production upload and binding
consumers run. Decoded and cloned plans must upload exact vertices/pixels, retain exact bounds and
resolve the planned frame hash; missing or evicted bindings fail. These are scene-slice checks,
not evidence of complete submitted-frame replay.

Imported raster tests capture PSD crop/row layout before runtime mutation and consume it without
source reevaluation, rejecting truncated layouts before GPU writes and disposing failed allocations.
A production-cache test checks PSD descriptor publication and replaced-owner lease retention. SVG
tests bind source revisions and bucketed extents; full G3 covers the actual rasterized output.
G1 checks the synchronous descriptor hash against WebCrypto and Rust; missing hashes fail before draw.
Scene media fixtures bind those actual frame hashes to ordered draw indices, including explicit
pending output and aliases. G1 round-trips the FPLN through Rust, resolves decoded references against
an independent registry, and rejects evicted frames. GPU adapter tests additionally replay serialized
references against newly admitted physical owners after the producing owners have been destroyed.
Complete captured-frame replay remains a separate exit requirement.
G1 also sends text/SVG/PSD binary pixel fixtures to the Rust resource registry through hash-named
payload files, then admits the returned descriptors and exact bytes into an independent TS registry.
It checks exact bounds/pixels, scope enforcement and dependency eviction; corrupt bytes, absent
frames, mismatched extents and conflicting pixel generations must fail. Decoded GPU upload adapter
tests discard producer-owned bytes before replay. The production capture harness additionally
reads installed text/SVG/PSD textures, independently uploads decoded resources, and compares GPU
readbacks byte-for-byte. Hash-named binary files and source/frame/pixel messages are retained under
each case's `raster-resources/`; frame metadata lists referenced pixel hashes and case metadata binds
payload, transcript and replay checksums. Candidate publication rejects missing or altered data.
M2 G3 requires this evidence, verifies all references and all three raster origins, and submits the
actual captured binary resources to the Rust registry. Its existing 1819-frame beauty comparison
remains exact. The separate frame-artifact audit described below covers complete submitted plans.
See [Frame-plan transport](FRAME_PLAN.md) for the current contract and its explicit partial scope.

Every fresh capture saves `plan.fpln` from the actual production submission, `replay.fpln` with
installed media pixel links, `replay.rust.fpln`, `resources.json`, and `rust.json` per frame. Resource
payloads are deduplicated under each case's `frame-resources/<hash>.bin`. Before independent TS GPU
replay, `aster-render-cli ir bundle` validates the complete resource closure, round-trips nested FPLN,
and proves that attaching pixels did not alter submitted execution. The returned root FPLN drives
replay. Frame metadata binds all file hashes, the native binary and the exact production/replay
pixel comparison. Candidate publication and M2 G3 both check all captured addresses, including
sequence neighbors. Missing or changed evidence fails publication. G1 additionally proves that
missing/corrupt resources, changed execution and partial plans fail native admission without output.
The command validates transport; it does not implement native GPU rendering.

Native runtime dependency validation decodes each distinct typed nested plan once per traversal
and checks its resource closure against an ordered set. The decoder enforces canonical JSON,
contiguous blob ranges, zero padding and typed payload invariants. Runtime traversal does not
re-encode those unchanged plans; `ir bundle` explicitly enables byte-for-byte reconstruction for
transport audits. Mutation tests require every accepted altered container to round-trip exactly,
and both traversal modes must reject noncanonical containers and missing dependencies.

Full G3 continues to compare all required TS frames under `exact`, retaining the effective reference
set proven unchanged by completed M1. Each renderer-source change requires a fresh candidate
capture. G1 success for a transport slice does not prove complete production plan consumption or
resource replay. The M2 exit auditor runs when M2-T15 is active or completed. It binds current full
G0/G1/G3 to unchanged source, regenerated schema, exact round trips, complete captured frame coverage,
resource pin/eviction checks, and the reviewed production/supplied execution boundary. Executable
root envelopes must declare completeness; partial stages cannot. Historical failed captures remain
rejected, with their recorded disposition and a current exact comparison of the affected address.
Quick mode skips full G1 and cannot authorize a commit. All required
gates must pass in a full run before committing.

## Performance evidence

Current preview input latency requires `serial-compositor-copy-v1` evidence from independent main
process compositor copies. Every sample must identify the calibrated visible frame, include a copy
started after its single input, and preserve monotonic nonoverlapping input/arrival times. Old
rate-limited frame-subscription reports, renderer completion, missing samples and changed quality
are rejected. Three complete 600-sample pairs still require native p95 no worse than TS; see
`docs/BENCHMARKS.md` for the observer and its conservative timing boundary.

`pnpm migrate:benchmark` measures the full warm-up and three-run workload schedule described in
`docs/BENCHMARKS.md`. Scope options such as `--smoke` are diagnostic and cannot replace the baseline.
The committed local Radeon 780M series is independent of historical NVIDIA results. Missing GPU
timing or encoder capabilities remain explicit limitations, never fabricated measurements.

The original throughput baseline and separate pre-plan preview baseline remain frozen. A saved
baseline validation alone is not a measurement. The preview series runs the actual production
present path and waits for GPU completion; its scope and warm-up protocol are specified in
`docs/BENCHMARKS.md`.
The baseline-freezing command refuses to replace an existing baseline or accept measurements taken
after production planning changes.

On 2026-10-05 (Asia/Tokyo), the owner approved `owner_overrides.performance_delivery_policy`
with kind `rust-delivery-v1`. M2 requires G0/G1/G3; M4, M6 and M7 require G0/G3, with GPU timings
and other performance observations recorded when useful rather than repeatedly enforced as hard
gates. M8, M11 and M12 retain G4: native export and preview must achieve higher median FPS than
the independently retained TS program run contemporaneously on the same machine, with matched
workloads and output quality. M11 also retains its input-to-present p95 latency requirement.
Fresh measurements must bind both programs, inputs, hardware conditions and raw evidence; the
candidate cannot serve as its own reference. Native paired G4 support remains to be implemented
and verified; existing TS measurements do not satisfy that final acceptance requirement.

The old fixed-reference 5 percent limits and M8's 75/120 fps targets remain historical references,
not blocking conditions for this migration. Frozen baselines and previous failed evidence remain
unchanged, with no failed run reclassified. Pixel, quality, functional and G0 requirements remain
in force, as does the full required-gates-before-commit rule.

Display-condition changes follow the hardware manifest's existing new-series policy. An additive
1920×1080@144Hz series may use the preserved pre-plan bundle only after its complete file set and
source/bridge provenance pass the historical-bundle audit. Reference reports identify historical
renderer bytes and current common harness sources separately. They must contain complete independent
throughput and preview observations at the new conditions. Current optimized output cannot become
its own reference. The series freezer refuses overwrite; its descriptor and file hash are pinned in
the ledger before comparisons use that series. Workload, encoder, host and method pins and raw-output
checks remain part of the evidence. The former 24 fixed-reference median checks are historical
diagnostics under `rust-delivery-v1`. Historical reports cannot satisfy a fresh candidate measurement.
No previous failed run is reclassified.

Generated evidence is stored under ignored `artifacts/`; hashes and paths in the ledger identify the
actual runs. Preserve these files when continuing on the same host. A missing or modified evidence
file must fail verification rather than being accepted from a previous status string.

G1 additionally round-trips four compiled layer-effect plans, covering identity/custom LUTs,
both pyramid flags, UTF-16 identities and exact unused instruction bits. It checks supplied
uniform/program bytes and rejects undeclared LUTs. G3 requires six independent LUT/effect draws:
identity, custom LUT, adjustment, blur, glow and soft-light blend. The old effect executor is pinned
from the pre-extraction commit and its six distinct RGBA16F outputs are frozen separately under
`tests/parity/lut-draw/reference`. A fresh page/device receives only Rust-returned effect plans and
texture resource payloads; all outputs must match the frozen bytes exactly. This supplements the
full-frame corpus and does not claim full frame-plan capture or native rendering.

G1 additionally transports 19 effect execution routing slices: all blend modes, direct rendering,
root skip, precomposition zero-op adjustment, overflow, disabled effects and a deferred malformed
LUT. The routing and fusion counts survive Rust unchanged, and inconsistent composites are rejected.
The required LUT/effect GPU replay now round-trips six routing slices alongside the six compiled
programs; supplied execution decisions still match the existing frozen outputs exactly. A production
precomposition test changes authored effects/blend after planning and verifies retained execution.

## Native raster admission

M5 G3 retains the M4 native regressions and adds 20 frames across ordinary text, animated multiscript
text, SVG, merged PSD and retained PSD layer cases. Plans, resources and references remain frozen;
the native batch reuses one device and records real image-cache uploads and hits. All 20 initial
outputs are RGBA-exact and have section 6.6 self-review evidence. CPU and GPU controls also cover
typed `RasterPixels` frame identity, eviction, changed pixel generations and atomic budget rejection.
G1 retains resource transport and lifetime checks. Passing raster admission does not establish M5
exit: the complete milestone exit audit remains separate from individual supplements.

The native temporal supplement executes four frozen M2 sample sets (full exposure, enters, exits and
transparent), using their original pass bytes and sample pixels. The input manifest is pinned in the
ledger and traced to the accepted M2 exit report; reference PNGs are unchanged. GPU controls require
identical repeated output from retained targets, atomic budget rejection, rejection of wrong sample
identities and transparent output after zeroing exposure. G3 compares the resolved raster directly
to its frozen reference and requires section 6.6 self-review. Complete root reconstruction is checked
by the separate motion-frame supplement below.

The native temporal frame supplement freezes two warmed production frames with two effect-isolated
precomposition surfaces and exact independent-device TS replay. It runs cached and uncached sequences
that poison captured resolved pixels, zero exposure, change one sample and restore the original frame.
Poisoning resolved pixels must preserve output and allocations; changing actual inputs must affect
more than 16 pixels and invalidate nested effect generations. All cached outputs must equal uncached
outputs. An intervening ordinary raster releases temporal targets, and restored temporal rendering
must still match. Budget rejection and explicit skipped-surface routing publish no PNG. Original
3D-shadow captures remain preserved for their later native capability.

The root motion supplement adds all four `scene-motion-blur` corpus frames to the native raster
batch and compares six frozen production temporal frames (full, entering and exiting exposure)
against independent-device TS replay. Cached and uncached sequences must agree, clear retained
motion targets, release them on an ordinary frame and restore the original result. Zero radius and
zero vectors must each change more than 16 pixels and produce the same unblurred output. Missing
auxiliary inputs, inconsistent beauty routing and insufficient GPU budget must reject without PNGs.
Receipts expose three reconstruction passes, target reuse and resident texture bytes. These checks
exercise the shared HDR shaders before the existing display transform, without CPU frame transport.

M5 exit requires a full current G0/G1/G3 run with all six raster/motion cases and retained core/effect
regressions. The exit audit rereads frozen manifests, actual PNGs, batch jobs, CLI receipts and
comparison reports, and matches section 6.6 reviews including sequence context. It also audits
resource hash/ownership, typed raster bounds, eviction and temporal pass transport in G1; all four
standalone temporal rasters; recursive and root whole frames; changed-input controls; retained-target
release; and earlier native optimization safety evidence. Missing/stale frames or supplemental
checks fail the exit even when a summary flag says passed. Native raster execution completes this
phase; shaping, video decode and production preview/export integration remain separate milestones.

## Native geometry, blend and supplied-image acceptance

M3 G3 executes the current release `aster-render-cli render-plan` against complete captured FPLN
bundles and their hash-pinned resource closure. The complete core scope covers 36 cases (145 frames):
solid/vector geometry, every blend mode, off/FXAA/SSAA2x/SSAA4x, supplied PNG/JPEG images, masks,
mattes, adjustments and recursive precomposition surfaces. Each receipt binds the native
adapter, plan hash, dimensions and decoded PNG pixels. Comparisons use the independently frozen
TS references under the specified `gpu` profile, including every structural check and recorded
section 6.6 self-review. M1/M2 retain their separate whole-corpus `exact` requirements.

The gate also checks rejection without output publication for unsupported features, allocation
budgets and corrupt resources, and preserves pre-existing output. Binary and input hashes must
remain stable throughout the run. Core coverage includes parented transforms, captured cloner
geometry, ellipse/rectangle effect masks and the existing path-mask schema case. `full_coverage`
is scoped to M3, not the entire migration corpus. The M3 exit auditor independently rereads every
actual native output, execution receipt, comparison and matching self-review. It rejects missing,
duplicate, stale or inconsistent evidence, and requires all three GPU cache/HDR tests and every
capability/resource rejection. G0/G1/G3 must pass together against unchanged source.

Supplied-image receipts require actual native texture uploads and report `native_image_decode: false`.
Supplied pixel hashes are bound to matching frame
descriptors and scene/root draw references before allocation. An ignored GPU test, run by G3,
checks repeated texture reuse, distinct pixel generations for one frame, current-frame eviction
protection, budget shrink and unchanged cache state after rejected input or insufficient budget.

A separate native-still subgate renders eight PNG/JPEG frames from original FPLN without captured
pixels. It materializes hash-pinned source files, grants each source and scope explicitly, and checks
native decode receipts plus the same frozen-reference GPU comparisons and self-reviews. Missing
grants, incorrect scopes/hashes and source/pixel budget violations must reject without publication.
The packaged FFmpeg executable and all source inputs are pinned for the run. These eight renders
supplement the 145 supplied-resource frames.

EXR has the recorded `ts-exr-import` reference boundary. G0 checks the real hash-pinned EXR asset's
linear sample values and rejects malformed extents, budgets and non-finite values. G1 round-trips
the additive `rgba16float` media descriptor. G3 also decodes an authorized HDR EXR file and runs the
production image shader through the actual float texture cache: associated `(4, -2, 0.25, 0.5)` must
survive exactly, proving that values were neither clipped to SDR nor sampled as sRGB. Float texture
budget rejection and reuse are checked on the GPU. A supplemental EXR frame-plan run replaces only
the captured image resource closure and records its native receipt and output; its report explicitly
does not claim unavailable TS EXR pixel parity. No frozen references or tolerances are modified.

The native layer increment adds all four frames of the three mask/matte scenes and the adjustment
layer case. These execute original supplied operation bytes, fixed alpha composition and scene
replacement on DX12, using the existing Electron DXC library with its hash recorded in G3. The
library is an explicit CLI input, never inferred from the frame plan. Every result uses the frozen
TS reference and the same GPU structural checks and self-review. Unsupported effect operations
outside the admitted native subset still reject. The full M3 exit additionally requires all core cases and its independent audit.

The recursive-surface increment additionally runs all eight original nested-precomposition and
nested-adjustment frames, including the captured blur/glow dependencies. Receipts require real GPU
surface allocations. G3 runs a GPU cache test for whole-set admission, unchanged state on rejected
budgets/dimensions, exact-identity hits, compatible-allocation reassignment, dimension changes and
retirement after shrink. Child-first routes are cross-checked with each captured geometry mapping.
Surface pixels remain linear and premultiplied until the root display pass. No pre-rendered child
pixels replace native child-scene execution.

Core acceptance preserves three reference boundaries: EXR uses native linear-sample and GPU proof
because TS cannot import it; the path-mask schema case retains the TS ellipse fallback; the
minimal golden animation is hidden by its opaque background. Animated parented transforms and
cloner geometry have separate visible cases. Native evaluation and native cloner generation remain
later milestones. M3 completion does not switch production preview/export away from TS.

## Native effect increments

M4 G3 retains the complete 145-frame M3 regression scope and adds 1087 frames across 271
captured effect and layer-style cases, including color, tone, distortion, temporal effects,
individual layer styles and LUTs. The explicit admission list is checked against the frozen corpus;
a new or omitted effect case fails coverage validation. This gives 1232 native replay frames. The eight LUT frames (`effect-lut` trilinear and
`lut-tetrahedral`) each require a real native LUT upload and resident
bytes, frozen-reference GPU comparisons and section 6.6 self-review. Root and recursive layer
programs bind their captured LUT hash, preserving the shared shader's interpolation and domain
semantics. A GPU test verifies exact half-float upload (including negative/HDR values), repeated
hits, whole-demand budget rejection without mutation, protected current entries and eviction under
budget shrink. G0 rejects invalid shapes and non-finite samples. The former LUT unsupported-feature
probe is replaced by the still-unsupported lighting route.

M4 increments report incomplete milestone coverage until every registered effect, layer style and
required native optimization has evidence. Passing this effect increment does not claim M4 completion
or switch the production preview/export path.

The diagnostic `render-plan --batch <jobs.json>` command accepts a bounded JSON array of
`{plan, resources, resource_manifest?, out}` jobs. It retains one native device, pipelines and GPU
caches across frames, but validates each supplied plan and resource closure independently. Outputs
must be unique absolute paths that do not already exist. Each PNG is published atomically, followed
by a receipt with its plan/pixel hashes, zero-based `frame_index` and `renderer_reused` flag. A later
invalid frame fails the command while preserving complete prior frames and leaving no failed-frame
PNG. G3 verifies all 1087 effect receipts, 1086 device reuses, duplicate/limit rejection and partial-failure
output integrity. This diagnostic readback path is not the production export pipeline.

Known shared integer effect opcodes are admitted without rewriting the supplied program. Unknown,
non-finite or fractional codes still fail; pyramid-dependent base blur/glow remain unsupported.
The 271-case scope proves supplied fused-program parity at the captured parameters, including the
six-operation combined layer-style chain. The production layer and root plan builders supply neutral
base parameters; user adjustments are compiled into effect operations. Native execution preserves
those uniforms. Arbitrary non-default legacy base blur/glow controls are not accepted by this proof.
Native optimizations require separate evidence before M4 exit. The color-range and twister fixtures are transparent in both
reference and candidate, so their acceptance does not prove nonempty behavior. Repeated frames
within each LUT case must increase cache hits without another upload; this check is independent
of the case position in the batch.

Native blur/glow pyramids use radius-bounded mip counts for allocation, transient admission and
per-layer recording. The radius audit covers every shared shader operation that samples a pyramid,
including channel maxima, compound blur bounds and signed bokeh CoC. Non-finite or unknown data
keeps full counts; shader operation admission still rejects unsupported programs. A guard mip
preserves interpolation and LOD rounding, and supplied max-LOD uniforms are unchanged. A native-only
two-target seed pass shares source taps when both chains are needed while preserving bright-pass
ordering; subsequent levels remain independent. Optimization comparisons must match the old native
compiler selection as well as the plan, adapter and pixels: early core cases use the default compiler,
whereas effects and later core routes use the pinned DXC. Matching the whole currently executable
1232-frame native scope does not establish support for later milestones' cases.

M4 additionally requires two native surface-post replays against the separately frozen M2 output
fixtures: selection isolation and vector motion blur. Extracted FPLN controls and HDR/object-ID/motion
attachments are pinned under `tests/parity/native-surface-post`; their original complete input JSON
hashes matched the frozen output manifest before extraction. A retained native GPU pipeline consumes
these supplied controls. G3 checks pixels, structural metrics and matching self-review records, while
the GPU test also proves control mutations change output, captured skips preserve the destination,
invalid attachment formats fail before writes, and replay restores identical pixels. These two
supplemental outputs are separate from the 1232 whole-frame corpus replays. Complete-frame surface
routing is verified separately below.

G3 also requires six native primary-auxiliary replays, comparing all five MRT attachments byte for
byte with the frozen M2 auxiliary references. The supplied scene, ID and motion plans are pinned in
`tests/parity/native-auxiliary-primary`; alpha-tested media and precomposition bindings retain their
captured inputs. Checks cover ID changes including `u32::MAX`, omitted draws, alpha texture removal,
motion removal, exact replay restoration, budget rejection and clearing previously drawn targets.
Only the primary normal/ID/world-position/motion attachments are claimed for higher-tier fixtures;
transparency aggregation, front color, depth peeling and generator execution remain pending.

Sixteen complete native surface frames cover selection isolation and vector motion blur with AA off,
FXAA, SSAA2x and SSAA4x, each with ready and skipped plans. The added reference set combines frozen
production geometry with explicit surface controls and a nonzero output clear; two independent TS
GPU devices produced identical reference frames. G3 runs all plans on one retained native device,
checks receipt identity, compares pixels and requires matching self-review records. Skipped frames
follow ready frames to expose stale targets. Admission tests reject mismatched modes, frame headers,
draw ranges and missing ready attachments before GPU recording; skipped plans without attachments
remain valid. Existing whole-frame and supplemental references are unchanged.


Native layer-effect pipelines can specialize the shared post shader by the set of reachable opcodes.
Admission is limited to programs composed of verified optical/color and wipe opcodes 12, 17, 18,
27, 50, 62, 82, 102, 104, 105 and 183; morphology and other programs retain the generic compiler path.
The transformation runs after the existing precision lowering and only removes unused opcode cases;
operation order, runtime parameters and shared arithmetic remain unchanged. The renderer retains at
most `--effect-pipeline-entries` variants (default 16) and uses its generic pipeline for additional or
unrecognized sets. Zero disables specialization for independent pixel and performance comparisons.
No per-frame parameter values enter the pipeline key, and no shader source is duplicated.
The generic effect pipeline compiles only when a nonempty program cannot use a retained variant,
including disabled specialization or a full variant cache. Preparation still visits every layer
after the cache fills so later unsupported programs always have their fallback ready.

Those specialized programs retain two recent blur samples per fragment invocation, keyed by the
exact UV and radius. A hit moves that sample to the front; a miss retires the least recent sample
and executes the original shared nine-tap sampler with its original LOD and arithmetic;
a hit reuses that result while textures and uniforms remain immutable. Private shader state resets
for every invocation, and no data is shared across pixels, draws or frames. Generic programs keep
their existing sampler. Acceptance requires corpus pixel comparisons and an unsampled export
observation; GPU timestamp runs only identify the affected layer and are not throughput acceptance.

The native layer-cache gate replays all 1232 current corpus frames and sixteen complete surface
frames with caching disabled, with immediate repeated frames on retained devices, and with both
caching and effect-region scissors disabled. All 4992 outputs must match the normal native receipt's RGBA hash exactly, and at least one retained output
must be reused. Compiler selection matches each case's existing native path. Disabled runs must
allocate no layer cache; enabled residency must stay within the explicit 64 MiB limit. This compares
the optimization to uncached native execution in addition to G3's unchanged TS reference comparisons.
GPU controls also check cross-time reuse, current-backdrop compositing, changed-effect invalidation,
cache and total-budget pressure, retained generations, and abandoned encoder copies. Three nested
GPU scenes prove descendant changes invalidate parent outputs and match uncached rendering. CPU
tests check geometry, lighting, LUT, media generation, aliases, clear/load semantics and recursive
time dependencies. A shared-WGSL consumer audit pins every opcode that reads or changes effect time;
unknown revisions retain the clock. Tint, LUT and combined layer-style replays must actually admit and
reuse their precomposition inputs. Adjustments and dependencies with unknown history remain
ineligible for result reuse.

Region comparisons must demonstrate a positive reduction in drawn pixel area with the cache disabled;
full-region controls must report zero bounded passes and equal full/drawn areas. GPU fixtures compare
padded outer glow and stroke against full-frame output at fractional geometry edges, then move the
geometry offscreen to prove empty regions clear correctly. CPU controls cover conservative padding,
unproved warps, non-neutral base settings and non-finite vertices. This admission intentionally keeps
spatial programs with unproved footprints full-frame; a surface quad spanning the viewport remains
full-frame even if its child texture contains transparent areas.

The SSAA effect-resolution safety control evaluates blur and outer glow at output resolution under
SSAA2x and SSAA4x, then bilinearly reconstructs their RGBA16Float results before the unchanged display
and AA passes. It retains the high-resolution geometry, source sampling, radii and blur pyramid.
Each full-resolution control must first match actual native renderer bytes. All four reduced-grid
comparisons exceed the hard maximum error of 8; three also exceed alpha coverage limits. Direct
contact-sheet and heatmap reviews reject the strategy. It exists only in GPU tests, and the production
renderer keeps full-resolution effects. G3 requires the expected rejection and matching ledger
self-reviews; its successful safety-control status does not mean reduced-resolution pixels passed.
No tolerance is loosened. This rejects the tested RGBA resampling strategy, not every possible
future decomposition that could preserve high-resolution alpha and demonstrate whole-corpus parity.

The M4 exit audit runs when `M4-T6` is active or M4 is already done. It requires all earlier M4 tasks,
current full G0/G3, and exact coverage of the frozen catalog's effect/style frames plus retained core
regressions. Corpus coverage tests bind the catalog to `EFFECT_REGISTRY`; additions cannot silently
inherit native admission. The audit reopens FPLN inputs, native PNGs, single-frame and batch receipts,
pixel reports, frozen references and matching self-reviews. It also audits sixteen complete surface
frames, two standalone surface effects, thirty primary auxiliary attachments, all 4992 cache/region
outputs and the four rejected SSAA experiments. Missing, duplicated, stale or substituted evidence
prevents milestone completion. Coverage is scoped to M4; text rasters, native video, higher-tier 3D,
export, native evaluation and production preview remain later milestones.

Native media increments retain the M5 raster/effect/cache regressions. The image-sequence gate uses
original plans without supplied pixels, explicit per-member authorizations and the packaged FFmpeg
snapshot decoder. Twelve frozen hold-boundary and frame-identity outputs are compared through the
corpus pixel gate; twelve reverse requests must reproduce them exactly without extra GPU uploads.
Missing/scope/member/byte-identity and allocation failures must publish no PNG. Sequence coverage
alone never establishes M6 completion: exact video timing, integration and the media exit audit remain
required.

The native video gate decodes all 44 fractional-rate and seek-boundary corpus frames from original
plans and explicit source grants. Each receipt must identify the expected presentation frame and
rational timestamp, retain source color metadata, and report CPU upload honestly. `decode` metrics,
structural checks and neighboring-frame identity are reviewed independently. Timestamp mismatch and
out-of-duration controls reject before publishing; an intentionally selected neighboring frame must
fail the pixel oracle. Source/pixel/index budgets and timeout controls remain required. These checks
do not establish production routing.

The video gate also checks 148 exact output comparisons across retained forward/reverse requests,
disabled decode caching, pixel-byte pressure and entry-count pressure. Every receipt must match the
original frame's source, selected timestamp, decoded hash and GPU output; cache counters must match
the requested identities and LRU limits. Sequence batches similarly require one decode per distinct
member identity and reuse for held/reversed frames. In-process EXR tests verify cancellation before
a cache hit, reuse of verified bytes after source removal, fresh authorization across job boundaries,
and renewed source access after either budget evicts the frame. This proves bounded decoded-frame
reuse; it does not claim a persistent streaming video codec or GPU decode interop.

Mixed-media inputs are independently captured through the production TS renderer and replayed exactly
on another device before freezing under `tests/parity/native-media-frame`. Six frames cover root and
two-level recursive scenes containing PNG, fractional-rate video and eight-sample temporal text at
forward/backward times. Capture requires visible alpha coverage and changing pixels; an empty
recursive fixture cannot pass merely because both renderers produced transparent output. Native
plans retain only raster pixel attachments and decode file media from SHA-256-bound grants. G3 checks
the active capture adapter, complete immutable resource closure, native decode receipts, temporal
execution, `decode` metrics/structural checks, sequence identity and full section 6.6 review evidence.
Root and recursive replay payloads containing supplied file-media pixels must be rejected without
publishing a PNG. The initial off-canvas fixture and failed comparison remain in the cycle evidence.

The M6 exit audit runs when `M6-T4` is active or M6 is already done. It requires current full G0/G3,
all earlier media tasks, all 12 sequence and 44 video corpus frames, and six frozen mixed scenes.
It rereads native batch logs, authorized snapshots, original plans, output PNGs, comparison reports
and matching self-reviews. Exact rational frame identity, color metadata, reverse/held sequence
pixels, 148 cache comparisons and independently recomputed LRU counters must agree with execution.
Authorization, budget, timeout, invalid-time and supplied-file-pixel controls must reject without
output; a neighboring video frame must fail the pixel oracle. Private snapshot directories must be
empty. Earlier core, effect, raster and GPU cache regressions are audited in the same run. Missing,
stale, duplicated or inconsistent evidence prevents completion even if a summary says passed.
This acceptance covers FFmpeg snapshot decode and GPU upload; streaming codec state, optional
hardware surface interop and production preview/export routing remain separate work.

M7 begins with twenty frozen orthographic/perspective camera and depth-of-field frames. Native
execution uses the captured shadow-map size and geometry, primary auxiliary MRT, front-color,
transparent aggregate and second-layer peel passes before shared depth shading. Receipts require
five depth passes and matching retained target reuse. Additional requests switch to ordinary beauty,
back to depth and then repeat; they must retire, rebuild and reuse the depth allocation while
reproducing the corresponding pixels exactly. An insufficient whole-frame GPU budget rejects without
output. All frames enter the existing pixel/self-review gate and cached/uncached regression batches.
This increment does not establish complete M7 coverage: material lighting, generators and recursive
scene integration retain explicit ledger tasks.

An independent scene-output capture supplements the frozen corpus with sixty-four complete frames:
overlapping translucent camera geometry, K0/K1/K2 depth with and without motion reconstruction,
depth fog, an explicit skipped-depth clear, and eight diagnostic views across all four AA modes.
Two independent TS devices must agree exactly. Sixteen paired controls require depth tier, motion
and skipped-output changes to alter visible pixels. Capture runs separately from native comparison;
its plan, resource and reference hashes are pinned in the ledger. Native cached/uncached batches
must agree exactly, report expected depth and motion passes, and release inactive targets. Each
output passes the GPU pixel profile and self-review; insufficient whole-frame memory rejects with
no output. Floating auxiliary views use the supplied render extent for their range; integer ID views
use real integer attachments rather than converting IDs to floats.

Material coverage adds the twelve frozen directional/point/spot frames and sixty independently
captured supplied mesh frames across all AA modes. Actual RGBA16F environments exercise intensity,
rotation, content generation changes and inactive fallback. Forty-four paired reference controls
require visible differences, including directional and spot shadow disable controls that change
both the pass flag and the lighting sampler flag. Two independent TS devices must agree before
references are pinned. Native batches require exact cache-on/cache-off output, two texture uploads
with later reuse, bounded resident bytes, GPU-profile pixels and self-review. Point shadows remain
the existing TS unsupported boundary.

Inline normal-map coverage captures 144 complete TS frames on two independent devices: three
lights, four AA modes, PNG/JPEG/WebP, positive/negative/zero scale and combined HDR. The native gate
requires all 144 frames under the unchanged GPU profile, exact cached/uncached output, exact
decoded texture hashes, and native decode/cache receipts. Windows JPEG normals use the built-in
Microsoft WIC decoder, whose pixels match the browser oracle. Earlier FFmpeg JPEG rounding
amplified to unacceptable material shading error; its failed evidence remains rejected. Other
platforms still reject JPEG normals. Another 24 independently repeated TS material frames cover
animated WebP first images: full and offset subframes, blend/replace flags, transparent canvas,
normal/zero scale and all four AA modes. Twelve controls establish visible normal-map influence.
`tests/parity/assets/animated-normal-textures.json` pins exact decoded bytes, which ignore the
opaque animation background and later red frame. The native adapter copies the decoded first
subframe onto a transparent canvas to avoid animated source-over rounding of opaque pixels.
Cached and uncached rendering must remain exact, with three decoded and GPU generations retained
under their byte budgets.
Dimension, chunk-boundary, cancelled-cache and allocation controls reject invalid inputs before
publication. `tests/parity/assets/normal-textures.json` preserves independently captured linear
texture bytes, including fractional and zero alpha. `image-webp` 0.2.4 (MIT OR Apache-2.0) replaces
FFmpeg WebP color conversion because its bilinear reconstruction matches the browser texture oracle;
the shipped FFmpeg build and source authorization contract are unchanged. WIC uses the existing
locked Windows bindings and the operating-system codec; it adds no bundled native codec library.

Root particle coverage executes twelve frozen billboard, mesh and streak frames at four supplied
rational times. The unchanged GPU profile includes sequence-neighbor identity checks and section
6.6 review. Native generator positions are marked invariant during Naga compilation: unrestricted
arithmetic reassociation lost one thin streak pixel despite matching nearly the entire image.
The failed pre-invariance comparison remains recorded. Cached/uncached and bounded/unbounded
effect-region runs must remain byte-identical, and a generator allocation-budget control must
reject before publishing output. Unit controls reject mismatched frame identity, realization,
missing/duplicate invocations and invalid shader text.

Fifteen frozen bars, ring and oscilloscope frames now exercise supplied root-time audio analysis in
the native generator graph. GPU controls silence the audio samples, add a visible sibling, omit
that sibling's redundant audio payload, restore the original frame and reject contradictory audio
records before output publication. Shared and inherited audio must produce identical pixels,
restored frames must match the frozen-input native baseline exactly, and both silence and a new
sibling must visibly change the image. The audio record is budgeted once per root frame. These checks
cover root beauty output.

Generator output references independently route frozen invocations through five auxiliary views,
unblurred beauty, motion reconstruction, K2 depth of field and an omitted-auxiliary control across four AA modes.
The 216 complete frames cover billboard, mesh, streak, bars, ring and scope. Two independent TS
devices must agree exactly before the reference manifest is pinned. Twenty-four particle controls prove
that auxiliary geometry and motion reconstruction change the image; the three beauty-only audio variants must retain the
same empty auxiliary result when no descriptor exists. Native cached and uncached outputs must agree
exactly, release motion/depth targets between routes, and pass pixel and structural self-review.

Case-specific peak-error adjustments live in the embedded `tests/parity/tolerance-overrides.json`
catalog and in the migration ledger. Only a matching case/profile may use one. The comparator caps
peak error at eight, enforces SSIM at least 0.995 and PSNR at least 40 dB, and preserves stricter base
limits and all structural limits. Exact comparisons cannot be relaxed. The billboard FXAA motion
case permits a peak of seven after review of two sparse edge pixels; its default mean/PSNR limits
remain unchanged. Native normalization uses vector/length division to avoid a one-ULP particle
position difference changing mesh raster coverage; no diagnostic particle readback remains.

Recursive generator integration uses 108 independently captured complete frames across six bundled
variants and four AA modes. Child-only, two-level child-first surfaces and captured unavailability
exercise routing through the retained root effect. Audio variants additionally compare explicit
shared input, inherited root input and silence. Thirty-six observable controls prove generator and
audio contributions; twelve conflicting root/child records must fail without publishing pixels.
Cached and uncached renders must match exactly, including three restored audio frames after other
scenes and silence. The pixel gate authenticates all inputs, resources and self-review hashes.
Post-fragment product boundaries preserve rounding before display conversion and FXAA. The native
lowering is restricted to the fragment entry; shader helper functions remain unchanged. Existing
corpus and output routes are rechecked against their frozen references after this lowering changes.

The M7 exit audit runs when `M7-T6` is active or M7 is already done. It requires completed prior
milestones and scene tasks, current full G0/G3, every camera/light/depth/generator corpus identity,
and all cloner and motion-blur cases already covered by native execution. Six supplement matrices
contain 616 complete frames: scene/depth output, HDR materials, encoded normals, animated normals,
generator output and recursive generator surfaces. Their exact identities, independently frozen
input/reference hashes, two cache modes, execution receipts and section 6.6 reviews are reread;
summary counts alone cannot establish completion. Observable controls are recomputed from actual
reference pixels, and every budget/audio rejection must leave its output absent. The audit also
checks depth retirement/recreation, frame audio restoration and all earlier media, effect, raster
and cache regressions. Case tolerance overrides must match the embedded catalog and the ledger;
all remaining limits stay unchanged. This audit reuses the current run's evidence without extra
GPU rendering. Native export routing, hardware encoding, evaluation and preview integration remain
in M8-M12.

M8 retains the complete native scene G3 regression and adds `native-session-gate.mjs`, which drives
the actual `serve` subprocess with authenticated frozen plans and resources. Checks cover binary
framing, bounded allocations, hashes, deduplication, eviction/recovery, temporary normal-texture
retirement and exact adapter selection. Hardware probing must produce ordered Annex-B packets
and complete drain at the requested media configuration. This is capability evidence, not export
quality or performance acceptance. Until NV12 and complete export validation exist, G3 reports
incomplete M8 coverage and unimplemented G4/G5/G6 remain failed. A GPU conversion smoke compares
NV12 color bars, horizontal/vertical impulses, border impulses and gradients against the bundled
FFmpeg with an explicit BT.709 limited-range conversion. It requires at most one code-value error
and mean signed bias at most 0.5. This diagnostic does not replace full-corpus pixel self-review
or hardware encode/decode quality checks.

The retained FFmpeg path's metadata flags do not themselves select the RGB-to-YUV matrix. A
local red-color control produced Y=81, U=90, V=240 (BT.601) despite BT.709 output tags, including
after lossless H.264 encode/decode. This evidence remains in
`artifacts/migration/cycle116-nv12-reference`. The native conversion follows the specified BT.709
matrix; its reference explicitly requests that matrix. Frozen TS baselines remain unchanged.

`native-export-stream-gate.mjs` additionally exercises the retained hardware encoder through the
actual sidecar. An authenticated supplied plan produces 60 native GPU frames at 30000/1001 fps;
packet identities and exact rational timestamps are checked before stream-copy MP4 muxing.
Independent ffprobe/decode checks require 60 frames, 2.002 seconds, BT.709 limited range and no
B-frames. Cancel/restart, early finish, missing resources, wrong order and GPU/packet budget
rejections must never report completion. This transport smoke does not claim audio/queue lifecycle,
whole-corpus quality or paired performance acceptance. M8 runs both forced readback and automatic
sharing selection. The automatic route must choose shared input on the qualified primary adapter,
retire every GPU lease, and produce identical decoded diagnostic pixels. A constrained GPU probe
budget must select hardware readback instead, record the exact reason and still complete export.

`native-electron-session-gate.mjs` compiles and drives the actual Electron Node client and native
MP4 session. Sixty native frames are streamed with 96,096 stereo Float32 samples at 48 kHz;
ffprobe must report 2.002 seconds for both video and audio within one AAC frame. Decoded video
must exactly match the direct sidecar diagnostic. Cancellation, missing frames and cancellation
during finish preserve an existing destination and remove temporary files. Transport tests cover
all control/binary split boundaries, malformed envelopes, bounded allocation, request correlation,
child crashes, deadlines and cancellation of a backpressured write. None establishes full queue
routing or replaces quality/performance acceptance.

The mixed-media capture additionally calls `planExportFrame` before the ordinary output render,
with canvas output access made fatal. Its native plan and resource bytes must exactly match those
extracted from ordinary production capture, with zero file-pixel captures. Independent-device
replay of the complete production capture must still match TS output for all six root/recursive
image, video and temporal-text frames, including cold input discovery. This checks the plan-only
boundary without changing the frozen baseline. Full M8 G3 executes this fresh capture.
Readback unit checks cover mixed texture dimensions, row-split batches, row padding and cleanup
after a later mapping fails. The same exact production capture comparison verifies batching on
the actual GPU. `native-owner-export.mjs --profile --frames 12 --out <fresh-directory>` optionally
records a renderer CPU profile through route selection; sampling runs are explicitly diagnostic
and run only Rust, so they cannot establish paired performance acceptance. This opt-in diagnostic
also records aggregate GPU initialization, compilation, validation, map, queue completion, digest
and bitmap API waits from document load
to route selection. It returns each original promise and removes its hooks at capture completion;
no media bytes, resource labels or private paths are recorded. Summed wait durations may overlap
and must not be interpreted as additive CPU time. Ordinary paired runs do not install these hooks.

`native-preflight-media-gate.mjs` admits all six frozen changing mixed-media plans through a
long-lived sidecar with explicit file grants, seals the bounded spool, then replays it through the
native encoder and Electron mux. It uses the production retained encoder preflight before admitting
plans, including its single fresh-process readback qualification after shared initialization fails.
The report binds the preflight module, attempt count, selected transport, failure reason and adapter
identity; a recovered initialization does not claim to repair the underlying driver fault.
Registry resource counts must equal the active supplied closure
after each admission; decoded file pixels must not leak into subsequent frames. The resulting
MP4 must contain six frames at 30 fps. Empty grants and supplied file-pixel overrides must reject.
Spool tests cover aggregate bounds, stable deduplication, mutated resources, failed admission,
incomplete sealing, cancellation while admission is pending and changed stored files. This is
lifecycle evidence, not encoded quality or complete queue-routing acceptance. Use the qualified
DXC compiler supplied with Electron; FXC cannot compile the complete effect shader set.

Resource transport tests cover ordered pipelining, fragmented/coalesced replies, aggregate bounds,
owned input bytes and cancellation during backpressure. Packed spool replay checks deduplicated
nonadjacent ranges, original resource order, corrupted bytes, growth and truncation. Native video
source-cache diagnostics compare retained, disabled and pressure modes with exact decoded pixels;
private snapshot and presentation-index bytes have independent bounded retention.

`native-export-job-gate.mjs` consumes fresh job-shaped production captures, checks immutable
job/header correlation, then drives the actual main-process native routing broker and strict output
request parser. Root and recursive mixed-media jobs must admit all frames, reject early mux start
and raw pixel input, encode exact frame counts/timing, and clean owned files. Cross-job plans,
incomplete preflight, unsupported codecs and cancellation during preparation/export must preserve
existing destinations. The retained encoder is initialized before native selection, so a driver
startup fault remains an explicit preflight rejection rather than a partially published export.
Renderer loop tests require whole-job fallback, no final TS readback on native selection, and
pause/cancel boundaries during admission. Deferred-operation tests require at most one frame of
preparation ahead of ordered admission and drain both lanes before pause, cancellation, fallback
or transport failure. These checks do not replace complete hidden-window,
packaging, corpus/owner quality or paired performance evidence.

M8 G6 uses `native-app-gate.mjs` to build a fresh package, run foreground/background automation
smokes with preview and background queue evidence, and authenticate the packaged renderer binary.
It then runs `native-queue-electron.mjs` against the packaged production page, sandboxed preload,
controller and persistent queue. The runtime resolver must locate the packaged renderer, DXC and
FFprobe. Fresh mixed-media snapshots exercise completion, audible stereo output, pause/resume
after native frame submission, cancellation before and during replay, and an explicit unavailable
renderer fallback. Frame count, duration, audio energy/sync, preserved destinations, queue state
and temporary cleanup are required. This also exercises production chunk initialization, which
isolated capture builds do not cover. G6 does not establish G5 corpus/owner pixel quality or G4
performance acceptance.

M8 verification runs G6 before G5 and binds the saved G6 report by SHA-256. G5's lifecycle audit
authenticates the same source revision, packaged application and renderer, runtime tools, capture,
queue report and resulting files. It rejects changed or incomplete evidence and never packages the
application a second time. The 120-frame pause scenario must pause before its last frame, holds
for 150 ms, requires stable frame progress and
an unchanged pre-existing destination, then resumes to completion. Cancellation must preserve that
destination. Every terminal scenario requires no active host, no extra output files and an empty
native temporary directory; the audit rechecks those directories. Lifecycle success does not accept
the remaining G5 corpus, owner-project or quality requirements.

The last native frame submission drains retained encoder packets and completes sidecar shutdown
before the renderer waits for PCM completion. This lets FFmpeg observe video EOF and drain a
backpressured audio pipe even for short exports. A rejected drain cannot publish a destination.
If shared transport initialization fails before admission, the broker disposes that sidecar and
makes one fresh hardware qualification attempt with native NV12 readback. Both initialization
failures are retained if it rejects; a successful retry reports the shared failure in its transport
reason. Cancellation prevents a retry. This bounded fallback does not claim the driver fault fixed.

`native-encoded-quality-case.mjs` is a diagnostic building block for G5. It authenticates a frozen
job-shaped lossless capture, runs native hardware H.264 and the retained FFmpeg path at the same
bitrate, scores both with the bundled VMAF filter, and emits decoded RGB `yuv` comparisons for
self-review. RGB bytes are preserved when discarding alpha, matching both MP4 production paths.
Relative VMAF success alone cannot accept failed absolute pixel/structural limits; diagnostic
reports never claim full export acceptance. Complete corpus and owner-project coverage is required.

M8's unified G5 now invokes `native-export-gate.mjs`. Its initial implementation runs fresh root
and recursive diagnostic clips through production whole-job admission, compressed replay and MP4
publication, then checks both encoders' stream metadata, decoded pixels and relative VMAF. It emits
the complete corpus's missing export coverage plus explicit owner, lifecycle and self-review gaps.
These diagnostic fixtures cannot satisfy corpus cases, even if their metrics pass. G5 remains failed
until complete export coverage and quality acceptance are implemented; quick mode skips execution
without granting required-gate or milestone acceptance. Explicit encoder tuning remains a separate
direct-session diagnostic and cannot qualify as the production route.
Decoded quality comparison consumes one RGBA frame at a time with pipe backpressure, bounded stderr
and a deadline for lack of validated consumer progress. Completing a frame comparison or accepting
bounded PCM bytes renews that deadline; stalled consumers and final decoder drain remain bounded.
The diagnostic YUV-to-RGB conversion uses accurate rounding and full chroma interpolation, avoiding
the systematic truncation bias of the default fast conversion. Frozen RGB references and pixel
thresholds are unchanged. It rejects partial, missing or extra frames and requires successful decoder
exit. Every candidate is compared with its corresponding lossless reference and both adjacent
references for frame identity; isolated diagnostic fixtures also check opaque-background ink bounds.
These structural results are required even when relative encoder quality passes.
The partial corpus runner exports complete addressed `minimal-golden`, `aa-fxaa` and
`scene-audio-spectrum-bars` segments and the full 300-frame `owner-main` segment through the
production native render host and independently retained TS program at the same 20 Mbps setting.
It authenticates the original corpus/project/resource identities and frozen reference PNGs, decodes
the complete outputs to verify frame counts, and compares the declared corpus frame addresses.
Only reference alpha is made opaque for MP4; RGB is unchanged. Corpus sequence and isolation flags
control structural context. Dense addressed segments also require neighbor-frame identity checks
within their original frame range, including the owner main segment. Both arms must retain the
exact assignment, source inputs, frame bounds and 20 Mbps configuration. Owner coverage remains
failed or awaiting self-review until its complete video, audio content and quality checks pass. Relative VMAF selects the declared frame indices directly from each
decoded MP4 YUV stream. Only the frozen RGB references are converted to BT.709 limited YUV420P;
candidate RGB round trips would add conversion error unrelated to encoder quality. Both streams
use identical integer timestamps, with EOF repetition disabled and exact score counts verified.
Successful execution remains separate from pixel, self-review,
remaining corpus, owner-project and lifecycle acceptance. These quality runs do not grant G4.
Owner-project and declared audio-layer cases require actual production audio. Each arm checks PCM
frame count, AAC format, stream presence, zero-based timestamps and matching stream durations.
The corpus runner also streams decoded stereo f32 PCM from both exports and requires identical
hashes over the addressed audio interval. AAC-LC tail padding is separately bounded to at most
1023 sample frames; truncation, extra padding, changed output hashes and content offsets fail.
This establishes alignment with retained TS audio, not lifecycle acceptance or independent mixer
correctness. Audio-free cases are explicitly not applicable only when both admissions and probes
agree. Video and audio decoding share bounded diagnostics, deadlines and child-process cleanup.
Optional `--encoder-quality-vs-speed`, `--encoder-rate-control`, `--encoder-max-qp` and
`--encoder-gop-frames` CLI
parameters set hardware `ICodecAPI` properties before media types and verify each retained value.
The production default is peak-constrained VBR with mean and peak bitrates explicitly bound to the
job's requested bitrate. Requested codec properties are read back after assignment and again after
media-type negotiation; disagreement rejects that hardware encoder. Quality/speed and GOP overrides
remain optional. This avoids unqualified driver rate defaults, including excessive filler output.
The quantization ceiling defaults to 18 and tightens to 12 when the requested bitrate provides at
least one bit per output pixel per frame. The budget calculation uses the exact rational frame
rate; it leaves mean/peak bitrate unchanged and never loosens an explicitly lower ceiling.
`--encoder-high-budget-max-qp` and `--encoder-high-budget-bits-per-pixel` configure this policy.
This prevents unnecessarily coarse initial intra frames in small outputs with ample bitrate;
ordinary 1080p/30 exports at 20 Mbps retain the ceiling of 18. Full export quality and measured
bitrate checks remain required; this budget rule alone does not establish acceptance.

The M8 GPU sharing smoke copies twelve changing NV12 frames through a shared DX12 resource and
reads both planes through a D3D11 device with the same adapter LUID. Every byte must equal the
native readback output. The non-aligned 66-by-34 extent exercises row padding and the final UV
pair. A held lease must reject slot reuse, released slots must support subsequent frames, and a
lease must remain readable after renderer shutdown. This establishes GPU transport and lifetime
behavior. The separate sidecar stream checks establish hardware consumption and lease retirement;
neither diagnostic replaces the complete corpus and owner-project quality gate.

M8 G3 also runs `native-untagged-video-gate.mjs`. It removes color tags from the authenticated
barcode fixture without re-encoding, captures fresh Chromium references, and tests six root and
recursive media frames including reverse seeks. Native receipts must identify the untagged SD
interpretation, all `decode` limits and structural checks must pass, and supplied file pixels must
still be rejected. Existing tagged-video references are unchanged. The raw-tag unit test rejects
explicit unsupported primaries, transfer, matrix and full-range declarations.

The native video gate also compares presentation-order decode windows against single-frame
decoding with the outer pixel cache disabled. Repeated frames, reverse seeks, source switches,
end-of-stream windows, zero-byte retention and byte pressure must preserve exact RGBA and frame
receipts. Reports expose process counts, window hits and retained byte/frame bounds independently
of source-index and decoded-frame cache statistics. Existing timeout, identity and cleanup
rejections remain required.

The default decode window admits up to 128 presentation frames within the unchanged 16 MiB byte
budget. Small videos amortize process startup across more frames; large frames remain limited by
the same byte budget, and the configurable frame count is bounded at 128. The window gate checks
eight-, 32- and default 128-frame windows against isolated
single-frame decoding, including seeks, source changes and end-of-stream truncation.

`native-owner-export.mjs --out <fresh-directory> [--frames <count>]` exercises the owner's main
segment through the production queue with real immutable linked-media snapshots, Chromium SVG
parsing, original resolution and audio. Omitting `--frames` exports all 300 main-segment frames.
Private project manifests and copied media live under a job-owned system temporary directory and
are removed after execution; the repository retains rendered outputs and diagnostic reports.
Both native and explicitly retained TS routes must complete with correct stream dimensions,
frame counts, duration and audio duration, release worker leases and remove export temporaries.
Elapsed time includes queue launch, admission/spooling, rendering, encoding and publication;
shared media snapshot preparation is reported separately. This single-pair diagnostic does not
establish repeated paired G4 acceptance or G5 pixel/VMAF quality acceptance.

M8 G4 uses `native-performance-gate.mjs --out <fresh-directory>` for both owner segments and
the three fixed synthetic scenes at 20 Mbps. It runs four matched pairs, alternating which renderer
goes first. The TS arm executes ledger-authenticated retained browser/Electron/bridge artifacts;
the Rust arm reuses one freshly built, authenticated production runtime snapshot. Each observation
completes ten warm-up frames before its prepared-to-durable-completion timer starts. The old
`native-owner-export.mjs --paired` queue diagnostic remains separate: its candidate-checkout TS
and enqueue timer cannot establish G4 acceptance.

The paired audit recomputes R-7 median/p95/p99 from raw FPS, elapsed and frame-completion samples.
It rejects missing/reordered observations, source/runtime/input changes, differing bitrate or audio
workloads, incomplete encoder drains, missing warm-up, omitted native work and invalid MP4 streams.
Hardware/run conditions and active browser GPU must remain stable; each native DX12 vendor/device
must match one active browser GPU, and the native probe/export LUID and adapter diagnostics must
remain identical across runs. Artifact hashes are rechecked after the series. Full G4 requires
native median FPS above retained TS on every required workload. Partial selection or two-pair,
ten-frame `--smoke` runs remain incomplete regardless of speed. G5 quality remains a separate gate.
`native-reference-export.mjs` now executes the independently retained TS browser, Electron and
bridge artifacts from the ledger-pinned historical series. It verifies frozen workload inputs,
per-run warm-up, original prepared-to-completed timing, MP4/audio stream evidence, run conditions
and input/program/output hashes. Tampered preserved runtime files fail both loading and final
auditing, while current candidate runtime changes cannot replace the reference. This separate
component now shares input, binary, hardware and output auditing with `native-benchmark-export.mjs`.
The native observation builds an explicit performance HTML entry, executes preserved candidate
runtime bytes, warms ten job frames on the retained device, and runs the production frame loop
through native-only admission and atomic MP4 publication. Audio is predecoded before timing;
planning, admission, render/encode, compressed storage, audio mixing and deferred mux creation
remain timed. The main process independently bounds the reported interval by observed admission
through finish. Missing warm-up, raw TS output, incomplete timings/counts, omitted measured work,
invalid output streams or remaining private files reject the observation. A single full-length
observation is not a three-run baseline or balanced paired acceptance. The paired runner audits
all observations together and requires the full workload and repetition coverage.
Admission diagnostics separately report input ownership, identity authentication, retained metadata
snapshots and compressed-spool writes. These intervals do not replace end-to-end export timing.
Matched bitrate does not itself establish matched quality: complete G5 remains independently
required before migration acceptance. `--smoke` truncates each workload to ten frames and `--case`
can select workloads for runner diagnostics; either prevents full G4 coverage. Sampling profiles
cannot run as part of paired acceptance. The normal `native-owner-export.mjs` diagnostic retains
its original single-pair behavior; `--paired` uses the same audited repeated schedule.

Whole-job native admission now decodes, renders and encodes each supplied plan once. The encoded
reply binds its plan SHA-256 and validated header to the queue assignment. Compressed Annex-B
replies remain private in a bounded 1 GiB spool until all frames pass and the hardware encoder drains
and shuts down. Input admission retains only bounded resource digests and frame counts, with
unchanged 31 GiB cumulative input, 262144-resource and 64 MiB frame limits. Admission tests check
that continuing references reuse private metadata snapshots while consumer inputs own independent
object trees and control buffers. New snapshots are captured before consumer access and published
only after successful admission; callback mutation cannot alter the next retained window. The real job gate checks
that production admission creates no raw-frame spool. MP4 replay reads authenticated compressed records,
without resubmitting plans, installing resources or decoding media again. Tests reject invalid
clock/order, missing frames, incomplete drain, storage overflow, altered bytes and cancellation;
the actual job gate also rejects a foreign frame after an earlier frame has already encoded.
No destination is published on late admission failure, and the whole job may still fall back to TS.

Native video planning is checked separately from browser video decoding. Metadata-only capture
must avoid seeks, Canvas2D conversion and file-pixel readback; fallback must create a fresh browser
decoder. Invalid metadata and interrupted preparation must reject or clean up. The mixed-media
production capture compares native-only plans/resources with the full TS capture and independently
replays the latter, covering root and recursive video, fractional times and raster inputs.
Native raster capture cache tests cover immutable caller ownership, changed texture generations,
descriptor tampering, LRU eviction, disabled retention, failed readback, disposal during readback
and the unchanged aggregate frame budget. Production capture still compares its cached native
input bytes with the independently uncached TS capture.


`native-corpus-schedule.mjs` schedules every declared corpus case by default. Each case runs both
production arms independently, writes an immutable report and file-hash checkpoint, and leaves
failed or unvisited cases explicit. `--case` selects a diagnostic subset; it never grants full
coverage. `--resume <report.json>` reauthenticates saved case files, frozen references, input
assignments, retained TS provenance and native runtime artifacts before reuse. Only ledger changes
are excluded from the separate execution fingerprint, so recording self-reviews can reuse pixels;
code, fixtures and other documentation changes invalidate old checkpoints. The full source hash
still includes the ledger and must remain unchanged during each active execution.

The scheduler builds one native runtime for its new cases and shares one authenticated reference
catalog within that schedule. Each case still rehashes every observed reference input before and
after export, including all repaired images, original neighbors and approval evidence. The catalog
is never reused across schedules. This avoids repeatedly decoding the same historical repair set
without relaxing input stability or checkpoint authentication.

Accepted non-exact output additionally
requires a matching ledger review, original frame identity, identical comparison fields and intact
contact-sheet/heatmap evidence. A rejection cannot be overridden by relative VMAF or a cached
summary. Whole-corpus scheduling and individual checkpoints do not by themselves satisfy the final
G5 lifecycle and milestone audit. Failed partial executions are retained and require a new output
directory for another attempt; successful checkpoints can be reused without re-exporting them.

G5 grants acceptance only after authenticated complete-case coverage, owner export, current G6
lifecycle evidence and both diagnostic clips pass, including their non-exact pixel self-reviews.
Checkpoint auditing rechecks production job identity, segment addresses, MP4 hashes, audiovisual
probe results, complete decoder frame counts, decoded audio summaries and per-frame VMAF logs.
Reference preparation and recovery share the same sequence domain, including sparse neighbors.
Review lookup uses the authenticated comparison's case identity so identical pixels from another
case cannot either grant acceptance or hide a valid review. Missing evidence remains a failure.
Seek-case frame declarations retain their identities while MP4 samples are compared in presentation
order. Standalone G5 accepts `--resume <scheduler-report>` and `--app-evidence <G6-report>`; both
are authenticated, and neither permits partial coverage or stale executable evidence to pass.

`aster-render-cli render-plan --nv12-out <new-file>` captures tightly packed BT.709 limited-range
NV12 from the same GPU frame as its diagnostic PNG. The receipt pins both outputs; the option is
incompatible with metadata-only and batch modes, reserves conversion memory before rendering, and
uses the production NV12 converter. This supports independent FFmpeg conversion checks without
adding H.264 quantization or changing any G5 reference domain. A diagnostic capture alone does not
establish complete corpus coverage.

Batch render jobs may set `nv12_out` individually in their bounded JSON manifest. Such a batch
must request NV12 for every frame and keep even output dimensions fixed. Validate every PNG/NV12
destination and plan dimension before executing the batch; duplicate, existing, relative and
parent-traversing output paths are rejected. The renderer and conversion buffers remain resident
between frames, while each receipt keeps its own plan, RGBA and NV12 identity. Ordinary PNG-only
batches retain their existing behavior.

M8 G3 includes `native-nv12-corpus.mjs`: all declared frames of all corpus cases must complete
independent conversion checks and section 6.6 self-review. The runner uses at most 32 same-size
frames per native batch. It authenticates frozen supplied plans/resources, renderer receipts and
binary identity, compares raw Y/U/V planes with independent FFmpeg conversion of the same native
RGBA (peak error <= 1 and absolute signed bias <= 0.5 per plane), and compares both uncompressed
NV12 decodes under the unchanged `yuv` structural profile. Strict native RGB rendering parity and
encoded G5 acceptance remain separate required checks.

M8 also compares every corpus frame against the frozen RGB oracle before encoding. The core,
effect and scene suites cover their declared frames; `native-corpus-rgb.mjs` fills the remaining
coverage from the authenticated pre-conversion PNGs already captured by the NV12 suite. This
includes the complete owner main segment and the declared opening, example, audio and media
frames. No additional rendering or reference regeneration is needed. Each case keeps its original
tolerance and structural context, including sequence neighbors. Exit auditing rejects omitted or
duplicated identities and reopens the native receipts, candidate PNGs, comparisons and self-reviews;
NV12 conversion success alone cannot establish RGB parity.

Use `node scripts/migration/native-nv12-corpus.mjs --out <new-directory>` for complete conversion
coverage; `--case <id>` is explicitly partial. Per-case checkpoints pin all output files, inputs
and execution sources. `--resume <previous-report>` authenticates those pins, recomputes plane
metrics and rechecks current self-review records without rerendering. Full milestone verification
accepts the same report through `--nv12-resume`. Missing, stale, failed or unreviewed cases never
satisfy full G3. Historical failed reports remain unchanged.

The shared export-quality scorer probes the bundled FFmpeg filter inventory and prefers libvmaf.
For codec comparison it fixes `vmaf_v0.6.1neg` for both encoders and all corpus/owner cases, with
native VMAF >= retained TS - 1.0 unchanged. The model excludes image-enhancement gain, as described
in [the VMAF model documentation](https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v0.md#disabling-enhancement-gain-neg-mode).
Audit the model identity and complete filter options against both authenticated command logs,
execution records and the pinned FFmpeg binary. Missing or mismatched models, repeated models,
unsupported model loads and forged execution records fail. Historical standard-model scores remain
immutable evidence and do not satisfy the new model requirement.
Only its absence enables the specified SSIM/PSNR fallback; execution or parsing failures never
select a weaker alternative. Both corpus and diagnostic clips use the same addressed samples,
integer timestamps, frozen RGB-to-BT.709 limited YUV420P reference conversion, and no EOF repetition.
Fallback acceptance requires both native SSIM >= retained TS - 0.002 and native PSNR >= retained
TS - 0.5 dB. PSNR is FFmpeg's pooled-MSE aggregate, not an average of per-frame dB values; lossless
positive infinity is preserved explicitly. Checkpoint auditing authenticates the encoder-tool
binary, filter inventory, per-frame statistics and command logs, verifies count/order and pooled
values, and recomputes both thresholds. These relative scores do not override decoded pixel,
structural, audio or agent self-review requirements. This earlier encoder change did not alter
G5's reference domain; the later owner-approved layered reference policy is described below.

The Electron session gate uses the application's retained encoder preflight, including its single
fresh-process NV12 readback attempt after shared-input initialization fails. Every session records
the attempted process count, selected native transport and failure reason. This preserves hardware
encoding and the same audio, timing, cancellation and atomic-output assertions. Separate stream
checks still exercise shared input; an encoder-driver crash remains recorded, not declared fixed.

M8 exit audits require the current full G0/G3/G4/G5/G6 set and completed implementation tasks.
The scene auditor accepts M8 explicitly while retaining every earlier RGB, media and lifetime check.
Saved session streams are decoded again; complete NV12 and encoded corpus checkpoints are reaudited
without launching missing work. Encoded reviews and frozen reference bindings remain authoritative.
All five performance workloads are recomputed from eight authenticated alternating observations,
and packaged lifecycle files are rechecked. Missing, stale or partial evidence fails the exit audit;
a green summary or diagnostic run alone cannot complete M8.

Owner queue diagnostics build a fresh application into their own artifact directory and execute
its preserved Electron modules and native binary. They pin and recheck the runtime just like paired
observations, rather than loading whichever files happen to remain in the checkout's `dist` tree.
CPU sampling is diagnostic only and never substitutes for the independently retained TS comparison.

Synchronous media descriptor hashing keeps a bounded cache keyed by the complete validated canonical
descriptor text. Admission validates kind, descriptor and empty payload before any cache lookup;
caller object identity and supplied hashes never establish a cache hit. The cache retains at most
4 MiB of UTF-16 key storage and 4,096 entries, with FIFO eviction. Binary payload hashes remain
uncached. Repeated-descriptor timings are diagnostics only; complete export performance still
requires matched paired G4 observations.

Automatic stream controls may make the same single fresh-process native readback attempt
as the application's preflight when an access violation occurs before `begin_export` replies.
Recovery requires a complete, ordered hardware-probe/resource prefix with no binary payload or
export response. Both the failed stream and its command metadata remain saved and are independently
reaudited at M8 exit. The retried control must actually start hardware NV12 readback and satisfy its
original completion, cancellation or rejection assertions. Reports record the actual selected
transport and require matching GPU-input retirement counts. Automatic readback selection requires
saved initialization-failure evidence or the native encoder's explicit qualification-failure reason.
The independent GPU shared-texture plane/lease test remains required. A crash after export starts,
malformed prefix, failed probe or failed retry still fails the gate. This verifies production
initialization recovery without declaring the driver crash fixed.

Shipping and native verification build the desktop bridge and render CLI in one Cargo invocation.
The `electron:native:build` script and IR, pixel, NV12, export-quality, parity-oracle and native
observation entrypoints share the release command in `scripts/native-build.mjs`.
Separate invocations can select different transitive dependency features
and produce different renderer machine code from unchanged sources. M8 exit therefore requires
the packaged render CLI's complete file hash to match the G3 executable and authenticates the
packaged file against that hash; source equality alone is insufficient.

Native frame IPC can reference resources from the immediately preceding accepted frame. References
carry only content hashes; main restores their previously authenticated control metadata and logical
payload sizes, while Rust retains the original verified bytes. Both the main admission window and
the sidecar resource window must contain every reference. The complete logical frame still counts
against the original byte/resource limits, even when its repeated payload is omitted from IPC.
Cold, duplicate and evicted references fail before resource installation. Failed or cancelled
admission never advances the reference window. Whole-job identity history continues to reject a
different full payload under an already admitted hash, and disposal releases reference metadata.
Production capture receives the preceding packet's resource closure so packet construction can omit
repeated payload copies as well as IPC bytes. A capture prepared concurrently with admission may
use that closure, but its packet is submitted only after the preceding admission succeeds. Rejected
or cancelled admission discards the speculative packet. Capture and admission both retain complete
logical resource budgets; newly transferred bytes remain owned snapshots.

Media descriptor hashing may reuse a private validated snapshot when every candidate field equals
the snapshot and the payload is empty. A claimed content hash only selects a candidate cache entry;
it does not authenticate modified fields. Snapshots are parsed from the exact canonical bytes that
were hashed. Both lookup indexes share FIFO eviction, with 4096 entries and a 4 MiB bound accounting
for canonical text and snapshot string storage. Binary resources always hash their supplied bytes.

Already validated media identity, binding-lease, bundle-store and GPU registry messages are copied
as plain wire trees. Bundle stores retain independent binary payload snapshots, including before
asynchronous hashing yields to callers.
Immutable strings are reused without structured-clone serialization; every object and array is
independently owned. Copies preserve UTF-16 identity arrays and exact requested/uploaded clocks,
and cannot mutate cached descriptors or binding leases. Admission and content hashing remain
unchanged; the copy helper is not a substitute for validation.
Own enumerable string values are captured before recursive copying. Output keys that also exist
on `Object.prototype` are defined as writable data properties so inherited setters, restrictions
and `__proto__` cannot intercept the copy; other keys avoid intermediate mapped entry arrays.

Native-only frame assembly encodes producer plans into owned bytes before asynchronous hashing.
Collection precedes GPU upload submission, which consumes pending temporal raster plans.
Each resource collector uses WebCrypto with at most 32 active digests. Owned small plans wait in
FIFO order instead of blocking assembly on synchronous hashing. Queued and active inputs share the 64 MiB bound,
with at most 65536 waiters; pressure fallback uses the same synchronous SHA-256 domain.
Dependencies and complete resource budgets remain validated. Assembly drains outstanding digests
on failure, and independently retained raster generations survive the hashing interval. Abort
prevents a pending assembly from starting a new raster capture. The synchronous TS rendering path
uses its existing assembly, allowing exact plan/resource comparisons against native-only capture.

Production native packet capture assembles raster links directly from privately verified pixel
owners. Packet assembly copies a newly transferred raster once and emits a reference for an already
retained hash, avoiding a complete intermediate raster bundle. Cache arrays never escape: metadata
accessors return copies and byte accessors authenticate the private-field brand. Admission still
counts the complete logical resource size, including omitted raster payloads. The independent mixed
media capture checks both full direct packets and retained-reference packets against the complete
production plan/resource bytes, including temporal text and recursive compositions.

Canonical metadata Unicode validation uses the runtime's native `isWellFormed` scalar scan when
available, with the existing Unicode regular-expression fallback on older web runtimes. Both
paths reject lone UTF-16 surrogates before serialization and preserve identical canonical bytes.

Native supplied-frame assembly reuses immutable nested plans from the complete dependency audit.
Root stages, effects, generators, precompositions and temporal passes share decoded plans only
within one frame. Retained encoded bytes are bounded by the caller's container limit (64 MiB by
default); overflow uses full decoding with the same limits. Closure, canonical bytes, typed blobs,
contract and frame identity checks remain mandatory, and failed assembly publishes no frame.

Canonical JSON serialization validates values and orders an independent object tree before native
serialization. Numeric-looking keys and sparse arrays retain the token serializer so JavaScript's
integer-key ordering and null substitution cannot change existing bytes. Input properties are read
once, including the fallback path; special prototype keys remain own data properties. Safe integer,
plain-object, ASCII-key and Unicode checks still precede serialization.

Native video lookahead can prefetch one adjacent window while the current window is consumed.
Both windows share the existing byte and frame allowance; pending statistics reserve the complete
future allocation. Each decode still waits for FFmpeg exit and validates errors and exact output
length before its bytes can be used. Seeks, source switches, authorization failures, cancellation
and decoder disposal cancel and join pending work. Small, disabled and single-frame windows keep
the synchronous path; `--video-decode-prefetch false` provides the same bounded comparison path.

Prefetch requires an already retained source snapshot, so its shared ownership stays inside the
source-cache accounting. Uncached or oversized source snapshots decode synchronously. Switching
source cancels and joins the pending task before source-cache lookup or eviction can occur.

Native export timing reports also retain the latest media, video-source, video-window and texture
cache statistics. These are cumulative session counters including warm-up, not sums of per-frame
snapshots; use them to distinguish repeated decode from resource installation cost.

Decoded file media has a 256 MiB default retention budget with the existing 256-entry bound.
Explicit byte limits, including zero to disable retention, keep their semantics. This avoids
repeated still-image decoding when a composition's concurrent image set exceeds 128 MiB; it does
not change individual decode limits, registry limits, or pixel conversion.

Within a frame, all requested file-media keys are protected from cache eviction until batch decode
finishes. If the complete working set exceeds the retention budget, an additional image is decoded
without displacing another image needed by the same frame. Protection is local to the batch and
does not survive errors, cancellation or the next frame; unrelated old entries remain evictable.

Export output-completion timing separates NV12 conversion/sharing or readback (including prior GPU
work) from hardware encoder submission/backpressure. GPU image and layer counters are latest session
snapshots including warm-up; effect-region counts accumulate only the measured export frames.

Authorized non-interlaced 8-bit RGB/RGBA PNG snapshots use the existing Windows WIC memory decoder
in-process, avoiding an FFmpeg child for each decoded-cache miss. The receipt reports
`windows-wic-png-snapshot` for images and sequence members; other layouts and platforms retain the
FFmpeg snapshot route. The common source grant, SHA-256 identity, extent/byte limits and canvas-alpha
rounding remain unchanged. WIC receives no filename or color-management transform. Cancellation and
the decode deadline are checked before publication. The native still/sequence gates require the
matching backend for their fixed PNG fixtures. An explicit ignored corpus test compares unmodified
RGBA code values against packaged FFmpeg for every PNG supplied in `ASTER_PNG_PARITY_INPUTS`.

Native canvas-alpha precision conversion preserves opaque RGB directly and clears hidden RGB
for fully transparent pixels. Partially transparent pixels retain the original integer
premultiply/unpremultiply rounding. An exhaustive 256-by-256 channel/alpha comparison checks
these shortcuts against that original rounding contract; native still/sequence and owner pixel
comparisons check the resulting rendered output.

The GPU layer cache reassigns evicted textures to new keys with identical extents after outstanding
GPU work completes. Reassignment clears both valid and pending content; abandoned command encoders
cannot publish old pixels under a new key. Admission order and the byte reservation remain unchanged,
with no spare allocation pool. Session statistics distinguish new `allocations` from allocation
`reuses`; both replacement paths count the retired content as an eviction.

`render-plan --gpu-timestamps` and `serve --gpu-timestamps` enable bounded GPU-stage diagnostics.
They require timestamp-query support and reserve two 1088-byte buffers plus 133 timestamp slots.
In addition to the five frame boundaries, up to 64 root render passes receive paired timestamps.
Per-frame receipts report their command/effect indices and elapsed times; excess passes are counted
explicitly. Export totals aggregate frame stages without accumulating per-frame pass lists.
Receipts distinguish temporal preparation, precomposition surfaces, the root scene, final output
processing (including motion/depth/AA), NV12 conversion, and NV12 transport copies. The query
readbacks deliberately synchronize execution, so these runs cannot accept G4 throughput. The
ordinary path requests no extra device features, allocates no query buffers, and omits the optional
`gpu_timings` receipt. Export totals exclude warm-up. Timestamp buffers are always unmapped after
success or failure; pixels still follow the normal renderer and conversion paths.

### Layered encoded-video references

The owner approved `layered-nv12-and-uniform-reference-v1` on 2026-10-13 (Asia/Tokyo).
G5 independently converts frozen opaque RGB references through uncompressed BT.709 limited NV12
and the same accurate RGB decode filter as exported video. `encoded-reference-domain.mjs` binds
original and converted PNG/pixel hashes, raw NV12 hashes, FFmpeg identity and exact commands.
The current frame and both temporal neighbors use the same conversion. Checkpoint recovery
revalidates this chain and the original frozen RGB-to-opaque adaptation; candidates never supply
reference pixels. G3 RGB/NV12 parity and comparative VMAF/SSIM/PSNR retain their original inputs.
Previous RGB-domain failures remain immutable evidence.

Only explicitly opted-in G5 `yuv` comparisons can report `uniform_reference_equivalence`:
the reference must be exactly uniform and opaque, candidate alpha must be identical, and every
RGB channel error must be at most one code value. The report retains `shift: null` and explains
that translation is unobservable. Other checks, including signed bias and sequence identity,
remain mandatory. Self-review recovery independently checks this exception against both PNGs.
Exact identity and ordinary measured registration are unchanged. The rule does not apply to G3.
