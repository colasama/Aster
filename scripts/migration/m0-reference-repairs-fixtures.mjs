import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { digest } from "../parity/provenance.mjs";
import { auditCaptureSet } from "./m0-captures.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { captured, fixture } from "./m0-exit-fixtures.mjs";

export async function repairFixture(t) {
  const f = await fixture(t);
  const data = await captured(f, { width: 32 });
  await f.json("tests/parity/corpus.json", data.corpus);
  const catalogBytes = await readFile(
    new URL("../../tests/parity/tolerances.json", import.meta.url),
  );
  await f.write("tests/parity/tolerances.json", catalogBytes);
  const catalog = JSON.parse(catalogBytes);
  const original = await auditCaptureSet(f.reader(), data.corpus, "refs", data.source);
  const directory = "snapshots/repair";
  const source = { renderer_source_sha256: "d".repeat(64), tree_sha256: "e".repeat(64) };
  const capture = JSON.parse(await readFile(join(f.root, "refs/sequence/capture.json")));
  capture.cache_key = digest({
    source: source.renderer_source_sha256,
    case: digest(capture.inputs),
    adapter: { device: "fixture" },
  });
  let replacement;
  for (const record of capture.frames) {
    const previous = `refs/sequence/${record.frame}`;
    const prefix = `${directory}/sequence/${record.frame}`;
    const image = await f.reader().image(`${previous}/frame.png`);
    if (record.frame === 1) image.pixels[0] += 1;
    const png = encodeRgbaPng(image.width, image.height, image.pixels);
    await f.write(`${prefix}/frame.png`, png);
    const meta = await f.reader().json(`${previous}/meta.json`);
    Object.assign(meta, {
      renderer_source_sha256: source.renderer_source_sha256,
      source_tree_sha256: source.tree_sha256,
      run_id: "repair-run",
      cache_key: capture.cache_key,
      png_sha256: sha256(png),
      rgba_sha256: sha256(image.pixels),
    });
    await f.json(`${prefix}/meta.json`, meta);
    record.png_sha256 = meta.png_sha256;
    record.meta_sha256 = await f.hash(`${prefix}/meta.json`);
    if (record.frame === 1) replacement = meta;
  }
  await f.json(`${directory}/sequence/capture.json`, capture);
  const host = { cacheIdentity: { device: "fixture" } };
  const manifest = {
    schema_version: 1,
    kind: "ts-candidate",
    source_verified: true,
    run_id: "repair-run",
    scope: "full",
    source,
    source_after: source,
    host,
    corpus_sha256: await f.hash("tests/parity/corpus.json"),
    selected_cases: ["sequence"],
    required_case_count: 1,
    required_frame_count: 1,
    captured_frame_count: 3,
    cases: [
      {
        case_id: "sequence",
        case_sha256: digest(capture.inputs),
        path: "sequence/capture.json",
        capture_sha256: await f.hash(`${directory}/sequence/capture.json`),
        requested_frames: [1],
        captured_frames: [1, 0, 2],
      },
    ],
    frames: [
      {
        case_id: "sequence",
        frame: 1,
        path: "sequence/1/frame.png",
        meta_path: "sequence/1/meta.json",
        png_sha256: replacement.png_sha256,
        rgba_sha256: replacement.rgba_sha256,
        meta_sha256: await f.hash(`${directory}/sequence/1/meta.json`),
      },
    ],
  };
  const manifestPath = `${directory}/manifest.json`;
  await f.json(manifestPath, manifest);
  await f.json("snapshots/capture.json", {
    status: "passed",
    exit_code: 0,
    source_unchanged: true,
    run_id: manifest.run_id,
    source,
    source_after: source,
    host,
    capture_mode: "candidate",
    cases: [{ id: "sequence", status: "passed" }],
    candidate: {
      manifest: manifestPath,
      manifest_sha256: await f.hash(manifestPath),
      scope: "full",
      case_count: 1,
      requested_frame_count: 1,
      captured_frame_count: 3,
    },
  });
  const metrics = {
    exact: false,
    pixel_count: 32,
    max_abs_channel_error: 1,
    mean_abs_error: 1 / 128,
    mean_squared_error: 1 / 128,
    rgb_mean_squared_error: 1 / 96,
    psnr: { kind: "finite", db: 10 * Math.log10(255 ** 2 * 96) },
    channel_tolerance: 2,
    pixels_above_tolerance: 0,
  };
  const comparison = {
    schema_version: 1,
    passed: true,
    self_review_required: true,
    profile: {
      name: "gpu",
      catalog_sha256: sha256(catalogBytes),
      limits: { min_ssim: null, ...catalog.profiles.gpu },
    },
    width: 32,
    height: 1,
    isolated: false,
    reference_rgba_sha256: original.frames.get("sequence/1").rgba_sha256,
    candidate_rgba_sha256: replacement.rgba_sha256,
    metrics,
    ssim: { mean: 0.999 },
    structural: {
      pixel_count: 32,
      cluster_error_threshold: 16,
      alpha_error_threshold: 8,
      largest_error_component: 0,
      alpha_changed_fraction: 0,
      signed_bias: [1 / 32, 0, 0, 0],
      ink_bounds: null,
    },
    registration: { status: "measured", shift: { dx: 0, dy: 0, distance: 0 } },
    sequence: {
      frame: 1,
      first_frame: 0,
      last_frame: 2,
      current_mean_squared_error: 1 / 128,
      passed: true,
      previous: {
        status: "compared",
        frame: 0,
        mean_squared_error: 35 / 128,
        current_is_closer: true,
      },
      next: { status: "compared", frame: 2, mean_squared_error: 31 / 128, current_is_closer: true },
    },
    checks: [
      "max_abs_channel_error",
      "mean_abs_error",
      "psnr",
      "error_clusters",
      "signed_bias",
      "alpha_coverage",
      "registration",
      "frame_identity",
    ].map((id) => ({ id, passed: true })),
  };
  const report = {
    schema_version: 1,
    comparison,
    context: {
      case_id: "sequence",
      isolated: false,
      background: null,
      sequence: { frame: 1, first_frame: 0, last_frame: 2 },
    },
    reference: { png_sha256: original.frames.get("sequence/1").png_sha256 },
    candidate: { png_sha256: replacement.png_sha256 },
    previous: { png_sha256: original.frames.get("sequence/0").png_sha256 },
    next: { png_sha256: original.frames.get("sequence/2").png_sha256 },
  };
  await f.json("review/report.json", report);
  await f.write("review/heatmap.png", encodeRgbaPng(32, 1, Buffer.alloc(128)));
  await f.write("review/contact-sheet.png", encodeRgbaPng(64, 2, Buffer.alloc(512)));
  const evidence = {
    report: "review/report.json",
    heatmap: "review/heatmap.png",
    contact_sheet: "review/contact-sheet.png",
  };
  for (const name of ["report", "heatmap", "contact_sheet"])
    evidence[`${name}_sha256`] = await f.hash(evidence[name]);
  const repair = {
    case_id: "sequence",
    frame: 1,
    directory,
    renderer_source_sha256: source.renderer_source_sha256,
    capture_report: "snapshots/capture.json",
    candidate_manifest: manifestPath,
    approval_review: evidence.report,
  };
  const review = {
    case_id: "sequence",
    frame: 1,
    profile: "gpu",
    purpose: "deterministic-ts-oracle-repair",
    reference_rgba_sha256: comparison.reference_rgba_sha256,
    candidate_rgba_sha256: comparison.candidate_rgba_sha256,
    verdict: "accepted",
    residual_class: "float-precision",
    evidence,
  };
  for (const field of ["metrics", "ssim", "structural", "registration", "sequence"])
    review[field] = comparison[field];
  return {
    ...f,
    corpus: data.corpus,
    original,
    catalogHash: sha256(catalogBytes),
    report,
    ledger: { reference_repairs: [repair], self_reviews: [review] },
  };
}
