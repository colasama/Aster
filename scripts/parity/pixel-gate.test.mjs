import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runPixelGate } from "./pixel-gate.mjs";
import { hash } from "./pixel-inputs.mjs";
import { decodeRgbaPng, encodeRgbaPng } from "./png.mjs";
import { digest } from "./provenance.mjs";

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "aster-pixel-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = {
    id: "fixture",
    project: "fixtures/project.json",
    composition: "composition",
    frames: options.frames ?? [0, 1],
    size: { width: 2, height: 1 },
    aa: "off",
    features: [],
    tolerance: options.profile ?? "exact",
    ...(options.isolated ? { isolated: true } : {}),
    ...(options.sequence ? { sequence: true } : {}),
  };
  const project = {
    compositions: [
      {
        id: "composition",
        background: options.background ?? [0, 0, 0, 0],
        frameRate: { numerator: 30, denominator: 1 },
        duration: 0.1,
      },
    ],
  };
  const projectPath = join(root, item.project);
  await json(projectPath, project);
  const inputs = { case: item, project_sha256: hash(await readFile(projectPath)) };
  const source = "a".repeat(64);
  const host = { cacheIdentity: { backend: "browser-webgpu", device: "fixture" } };
  const cacheKey = digest({ source, case: digest(inputs), adapter: host.cacheIdentity });
  const ledger = { reference_baseline: { renderer_source_sha256: source }, self_reviews: [] };
  const capture = {
    schema_version: 1,
    source_verified: true,
    case_id: item.id,
    cache_key: cacheKey,
    inputs,
    frames: [],
  };
  const reference = join(root, "artifacts", "parity", "reference", item.id);
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  const manifest = { schema_version: 1, frames: [] };
  for (const frame of options.sequence ? [0, 1, 2] : item.frames) {
    const pixels = Buffer.from([10 + frame, 20, 30, 255, 1, 2, 3, 0]);
    const png = encodeRgbaPng(2, 1, pixels);
    const directory = join(reference, String(frame));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "frame.png"), png);
    const meta = {
      case_id: item.id,
      frame,
      size: item.size,
      pixel_format: "rgba8",
      cache_key: cacheKey,
      renderer_source_sha256: source,
      host,
      case_sha256: digest(inputs),
      png_sha256: hash(png),
      rgba_sha256: hash(pixels),
    };
    await json(join(directory, "meta.json"), meta);
    capture.frames.push({
      frame,
      png_sha256: hash(png),
      meta_sha256: hash(await readFile(join(directory, "meta.json"))),
    });
    if (item.frames.includes(frame)) {
      await writeFile(join(candidateDirectory, `${frame}.png`), png);
      manifest.frames.push({
        case_id: item.id,
        frame,
        path: `${frame}.png`,
        png_sha256: hash(png),
      });
    }
  }
  await json(join(reference, "capture.json"), capture);
  await json(join(root, "tests", "parity", "corpus.json"), { cases: [item] });
  await json(join(root, "tests", "parity", "tolerances.json"), {
    schema_version: 1,
    profiles: {
      exact: { exact: true },
      gpu: {
        exact: false,
        max_abs_channel_error: 2,
        mean_abs_error: 0.05,
        min_psnr_db: 50,
        structural: {},
      },
    },
  });
  const ledgerPath = join(root, "docs", "migration", "rust-renderer-progress.json");
  await json(ledgerPath, ledger);
  const manifestPath = join(candidateDirectory, "manifest.json");
  await json(manifestPath, manifest);
  return {
    root,
    item,
    reference,
    projectPath,
    manifest,
    manifestPath,
    ledgerPath,
    ledger,
    calls: [],
    context: { root, output: join(root, "run"), env: {} },
  };
}

function execute(fixture, changes = {}) {
  return async (command) => {
    fixture.calls.push(command);
    const arg = (name) => command.args[command.args.indexOf(name) + 1];
    const referenceBytes = await readFile(arg("--reference"));
    const candidateBytes = await readFile(arg("--candidate"));
    const reference = decodeRgbaPng(referenceBytes);
    const candidate = decodeRgbaPng(candidateBytes);
    const profile = arg("--tolerance");
    const context = JSON.parse(await readFile(arg("--context"), "utf8"));
    const same = reference.pixels.equals(candidate.pixels);
    const report = {
      schema_version: 1,
      reference: { png_sha256: hash(referenceBytes) },
      candidate: { png_sha256: hash(candidateBytes) },
      previous: context.sequence?.previous
        ? { png_sha256: hash(await readFile(context.sequence.previous)) }
        : null,
      next: context.sequence?.next
        ? { png_sha256: hash(await readFile(context.sequence.next)) }
        : null,
      context,
      comparison: {
        schema_version: 1,
        passed: same,
        self_review_required: profile !== "exact",
        isolated: context.isolated,
        profile: {
          name: profile,
          catalog_sha256: hash(
            await readFile(join(fixture.root, "tests", "parity", "tolerances.json")),
          ),
        },
        width: reference.width,
        height: reference.height,
        reference_rgba_sha256: hash(reference.pixels),
        candidate_rgba_sha256: hash(candidate.pixels),
        metrics: { exact: same, max_abs_channel_error: same ? 0 : 255 },
        ssim: { mean: same ? 1 : 0, channels: [1, 1, 1, 1] },
        structural:
          profile === "exact"
            ? null
            : {
                largest_error_component: 0,
                ink_bounds: context.isolated ? { same_emptiness: true } : null,
              },
        registration:
          profile === "exact"
            ? null
            : { status: "exact_identity", shift: { dx: 0, dy: 0, distance: 0 } },
        sequence: context.sequence ? { passed: true } : null,
        checks: (profile === "exact"
          ? ["exact_rgba"]
          : [
              "max_abs_channel_error",
              "mean_abs_error",
              "psnr",
              "error_clusters",
              "signed_bias",
              "alpha_coverage",
              "registration",
              ...(context.isolated ? ["ink_bounds"] : []),
            ]
        ).map((id) => ({ id, passed: same })),
      },
    };
    if (context.sequence) report.comparison.checks.push({ id: "frame_identity", passed: true });
    changes.report?.(report);
    const directory = arg("--out");
    await json(join(directory, "report.json"), report);
    await writeFile(join(directory, "heatmap.png"), referenceBytes);
    await writeFile(
      join(directory, "contact-sheet.png"),
      encodeRgbaPng(
        reference.width * 2,
        reference.height * 2,
        Buffer.alloc(reference.width * reference.height * 16),
      ),
    );
    await changes.after?.(command);
    return { status: same ? "passed" : "failed", exit_code: same ? 0 : 1, ...changes.result };
  };
}

test("full exact comparison covers every corpus frame without regenerating references", async (t) => {
  const data = await fixture(t);
  const result = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(result.status, "passed");
  assert.equal(result.full_coverage, true);
  assert.equal(result.required_count, 2);
  assert.equal(result.comparisons.length, 2);
  assert(data.calls.every((call) => call.args[0] === "compare"));
  assert.equal(result.inputs_unchanged, true);
});

test("diagnostic subset is explicit and does not claim full coverage", async (t) => {
  const data = await fixture(t);
  data.manifest.frames.pop();
  await json(data.manifestPath, data.manifest);
  const result = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath, scope: "diagnostic" },
    execute(data),
  );
  assert.equal(result.status, "passed");
  assert.equal(result.scope, "diagnostic");
  assert.equal(result.full_coverage, false);
  assert.equal(result.required_count, 2);
  assert.equal(result.frames.length, 1);
});

for (const scenario of ["missing", "duplicate", "unknown", "escape", "absolute", "missing-hash"]) {
  test(`candidate manifest rejects ${scenario} before invoking the CLI`, async (t) => {
    const data = await fixture(t);
    if (scenario === "missing") data.manifest.frames.pop();
    if (scenario === "duplicate") data.manifest.frames.push(data.manifest.frames[0]);
    if (scenario === "unknown") data.manifest.frames[0].frame = 99;
    if (scenario === "escape") data.manifest.frames[0].path = "../0.png";
    if (scenario === "absolute") data.manifest.frames[0].path = join(data.root, "0.png");
    if (scenario === "missing-hash") delete data.manifest.frames[0].png_sha256;
    await json(data.manifestPath, data.manifest);
    const result = await runPixelGate(
      data.context,
      { manifestPath: data.manifestPath },
      execute(data),
    );
    assert.equal(result.status, "failed");
    assert.equal(data.calls.length, 0);
  });
}

for (const target of ["candidate", "reference", "metadata", "project"]) {
  test(`changed ${target} data fails before comparison`, async (t) => {
    const data = await fixture(t, { frames: [0] });
    const path =
      target === "candidate"
        ? join(dirname(data.manifestPath), "0.png")
        : target === "reference"
          ? join(data.reference, "0", "frame.png")
          : target === "metadata"
            ? join(data.reference, "0", "meta.json")
            : data.projectPath;
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" ")]));
    const result = await runPixelGate(
      data.context,
      { manifestPath: data.manifestPath },
      execute(data),
    );
    assert.equal(result.status, "failed");
    assert.equal(data.calls.length, 0);
  });
}

test("sequence context derives the complete domain and validates both adjacent references", async (t) => {
  const data = await fixture(t, { frames: [1], sequence: true });
  const result = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(result.status, "passed");
  const context = JSON.parse(
    await readFile(join(data.context.output, "contexts", "fixture-1.json"), "utf8"),
  );
  assert.equal(context.sequence.first_frame, 0);
  assert.equal(context.sequence.last_frame, 2);
  assert.equal(context.sequence.previous, join(data.reference, "0", "frame.png"));
  assert.equal(context.sequence.next, join(data.reference, "2", "frame.png"));
  await writeFile(join(data.reference, "2", "frame.png"), "corrupt neighbor");
  const again = await runPixelGate(
    { ...data.context, output: join(data.root, "again") },
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(again.status, "failed");
});

test("isolated cases require their actual project background to be transparent", async (t) => {
  const data = await fixture(t, { frames: [0], isolated: true, background: [1, 1, 1, 1] });
  const result = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(result.status, "failed");
  assert.match(result.frames[0].error, /transparent/);
  assert.equal(data.calls.length, 0);
});

test("exit code, profile, and input hash contradictions fail closed", async (t) => {
  for (const [index, changes] of [
    { result: { exit_code: 1 } },
    {
      report: (report) => {
        report.comparison.profile.name = "gpu";
      },
    },
    {
      report: (report) => {
        report.candidate.png_sha256 = "0".repeat(64);
      },
    },
    {
      report: (report) => {
        report.comparison.checks = [];
      },
    },
    {
      report: (report) => {
        report.comparison.checks.push(report.comparison.checks[0]);
      },
    },
  ].entries()) {
    const data = await fixture(t, { frames: [0] });
    const result = await runPixelGate(
      { ...data.context, output: join(data.root, `run-${index}`) },
      { manifestPath: data.manifestPath },
      execute(data, changes),
    );
    assert.equal(result.status, "failed");
  }
});

test("candidate changes after CLI execution invalidate the whole run", async (t) => {
  const data = await fixture(t, { frames: [0] });
  const result = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath },
    execute(data, {
      after: async () => {
        await writeFile(join(dirname(data.manifestPath), "0.png"), "changed");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.inputs_unchanged, false);
  assert.match(result.error, /Input changed/);
});

for (const scope of ["full", "diagnostic"]) {
  test(`${scope} non-exact numeric success remains incomplete without self-review`, async (t) => {
    const data = await fixture(t, { frames: [0], profile: "gpu" });
    const result = await runPixelGate(
      data.context,
      { manifestPath: data.manifestPath, scope },
      execute(data),
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.frames[0].self_review_required, true);
  });
}

test("a matching accepted review is bound to pixels, metrics, and inspectable evidence", async (t) => {
  const data = await fixture(t, { frames: [0], profile: "gpu", isolated: true });
  const initial = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(initial.status, "incomplete");
  const { comparison, evidence } = initial.comparisons[0];
  const review = {
    case_id: "fixture",
    frame: 0,
    profile: "gpu",
    reference_rgba_sha256: comparison.reference_rgba_sha256,
    candidate_rgba_sha256: comparison.candidate_rgba_sha256,
    metrics: comparison.metrics,
    ssim: comparison.ssim,
    structural: comparison.structural,
    registration: comparison.registration,
    sequence: comparison.sequence,
    residual_class: "float-precision",
    verdict: "accepted",
    evidence,
    report_sha256: hash(await readFile(join(data.root, evidence.report))),
  };
  await json(data.ledgerPath, { ...data.ledger, self_reviews: [review] });
  const accepted = await runPixelGate(
    { ...data.context, output: join(data.root, "accepted") },
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(accepted.status, "passed");
  await json(data.ledgerPath, {
    ...data.ledger,
    self_reviews: [review, { ...review, verdict: "rejected" }],
  });
  const rejected = await runPixelGate(
    { ...data.context, output: join(data.root, "rejected") },
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(rejected.status, "failed");
  await json(data.ledgerPath, {
    ...data.ledger,
    self_reviews: [{ ...review, residual_class: "structural" }],
  });
  const structural = await runPixelGate(
    { ...data.context, output: join(data.root, "structural") },
    { manifestPath: data.manifestPath },
    execute(data),
  );
  assert.equal(structural.status, "failed");
});

test("full gates reject unrecorded profile relaxation", async (t) => {
  const data = await fixture(t, { frames: [0] });
  const result = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath, profileOverride: "perceptual" },
    execute(data),
  );
  assert.equal(result.status, "failed");
  assert.equal(data.calls.length, 0);
});

test("a non-exact report cannot omit required numeric checks", async (t) => {
  const data = await fixture(t, { frames: [0], profile: "gpu" });
  const result = await runPixelGate(
    data.context,
    { manifestPath: data.manifestPath },
    execute(data, {
      report: (report) => {
        report.comparison.checks = report.comparison.checks.filter((check) => check.id !== "psnr");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.match(result.frames[0].error, /check set/);
});

for (const scenario of ["missing-hash", "wrong-hash", "wrong-path", "wrong-size", "missing-ssim"]) {
  test(`self-review rejects ${scenario} evidence even when the pixel hashes match`, async (t) => {
    const data = await fixture(t, { frames: [0], profile: "gpu" });
    const initial = await runPixelGate(
      data.context,
      { manifestPath: data.manifestPath },
      execute(data),
    );
    const { comparison, evidence } = initial.comparisons[0];
    const review = {
      ...comparison,
      case_id: "fixture",
      frame: 0,
      profile: "gpu",
      residual_class: "float-precision",
      verdict: "accepted",
      evidence: { ...evidence },
    };
    if (scenario === "missing-hash") delete review.evidence.heatmap_sha256;
    if (scenario === "wrong-hash") review.evidence.heatmap_sha256 = "0".repeat(64);
    if (scenario === "wrong-path") review.evidence.heatmap = review.evidence.contact_sheet;
    if (scenario === "missing-ssim") delete review.ssim;
    if (scenario === "wrong-size") {
      const wrong = encodeRgbaPng(1, 1, Buffer.from([0, 0, 0, 255]));
      await writeFile(join(data.root, evidence.heatmap), wrong);
      review.evidence.heatmap_sha256 = hash(wrong);
    }
    await json(data.ledgerPath, { ...data.ledger, self_reviews: [review] });
    const result = await runPixelGate(
      { ...data.context, output: join(data.root, "reviewed") },
      { manifestPath: data.manifestPath },
      execute(data),
    );
    assert.equal(result.status, "failed");
  });
}
