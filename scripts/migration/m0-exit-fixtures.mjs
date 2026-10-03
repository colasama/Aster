import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { digest } from "../parity/provenance.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-m0-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, bytes) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  };
  const json = (path, value) => write(path, JSON.stringify(value));
  const hash = async (path) => sha256(await readFile(join(root, path)));
  return { root, write, json, hash, reader: () => new M0Evidence(root) };
}

export async function captured(f, { omitNeighbor = false, wrongSource = false, width = 1 } = {}) {
  const source = "a".repeat(64);
  const item = {
    id: "sequence",
    project: "project.json",
    composition: "main",
    frames: [1],
    size: { width, height: 1 },
    aa: "off",
    tolerance: "gpu",
    sequence: true,
  };
  await f.json(item.project, {
    compositions: [{ id: "main", duration: 3, frameRate: { numerator: 1, denominator: 1 } }],
  });
  const frames = omitNeighbor ? [1, 0] : [1, 0, 2];
  const inputs = { case: item, frames, project_sha256: await f.hash(item.project) };
  const host = { cacheIdentity: { device: "fixture" } };
  const cacheKey = digest({ source, case: digest(inputs), adapter: host.cacheIdentity });
  const capture = {
    schema_version: 1,
    source_verified: true,
    case_id: item.id,
    cache_key: cacheKey,
    inputs,
    frames: [],
  };
  for (const frame of frames) {
    const pixels = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) pixels.set([frame, 20, 30, 255], x * 4);
    const png = encodeRgbaPng(width, 1, pixels);
    const prefix = `refs/sequence/${frame}`;
    await f.write(`${prefix}/frame.png`, png);
    const meta = {
      case_id: item.id,
      frame,
      requested: frame === 1,
      renderer_source_sha256: wrongSource && frame === 2 ? "b".repeat(64) : source,
      run_id: "older-run",
      source_tree_sha256: "b".repeat(64),
      case_sha256: digest(inputs),
      cache_key: cacheKey,
      host,
      pixel_format: "rgba8",
      png_sha256: sha256(png),
      rgba_sha256: sha256(pixels),
      size: item.size,
      aa: "off",
      frame_rate: { numerator: 1, denominator: 1 },
      time: frame,
    };
    await f.json(`${prefix}/meta.json`, meta);
    capture.frames.push({
      frame,
      png_sha256: sha256(png),
      meta_sha256: await f.hash(`${prefix}/meta.json`),
    });
  }
  await f.json("refs/sequence/capture.json", capture);
  return { corpus: { cases: [item] }, source };
}

export async function comparison(f, side, original, pixels, passed) {
  const profile = passed ? "exact" : "gpu";
  const path = `oracle/${side === "positive" ? "exact-positive" : "missing-patch"}.png`;
  await f.write(path, encodeRgbaPng(320, 180, pixels));
  const candidate = {
    png_sha256: await f.hash(path),
    rgba_sha256: sha256(pixels),
    width: 320,
    height: 180,
  };
  const value = {
    schema_version: 1,
    passed,
    self_review_required: !passed,
    profile: { name: profile, catalog_sha256: "c".repeat(64) },
    width: 320,
    height: 180,
    isolated: false,
    reference_rgba_sha256: original.rgba_sha256,
    candidate_rgba_sha256: candidate.rgba_sha256,
    metrics: {
      exact: passed,
      pixel_count: 57600,
      max_abs_channel_error: passed ? 0 : 255,
      mean_abs_error: passed ? 0 : 1,
      mean_squared_error: passed ? 0 : 1,
      rgb_mean_squared_error: passed ? 0 : 1,
      pixels_above_tolerance: passed ? 0 : 400,
    },
    ssim: null,
    structural: passed ? null : { largest_error_component: 400, alpha_changed_pixels: 400 },
    registration: null,
    sequence: null,
    checks: passed
      ? [{ id: "exact_rgba", passed: true }]
      : [
          { id: "error_clusters", passed: false },
          { id: "alpha_coverage", passed: false },
        ],
  };
  const report = {
    schema_version: 1,
    context: { case_id: "shape-ellipse", isolated: false, sequence: null },
    reference: { png_sha256: original.png_sha256 },
    candidate: { png_sha256: candidate.png_sha256 },
    comparison: value,
  };
  const prefix = `oracle/${side}/frames/shape-ellipse-0`;
  await f.json(`${prefix}/report.json`, report);
  await f.write(`${prefix}/heatmap.png`, encodeRgbaPng(320, 180, Buffer.alloc(320 * 180 * 4)));
  await f.write(
    `${prefix}/contact-sheet.png`,
    encodeRgbaPng(640, 360, Buffer.alloc(640 * 360 * 4)),
  );
  const evidence = {
    report: `${prefix}/report.json`,
    heatmap: `${prefix}/heatmap.png`,
    contact_sheet: `${prefix}/contact-sheet.png`,
  };
  for (const name of ["report", "heatmap", "contact_sheet"])
    evidence[`${name}_sha256`] = await f.hash(evidence[name]);
  const gate = {
    id: "G3",
    status: passed ? "passed" : "failed",
    scope: "diagnostic",
    full_coverage: false,
    inputs_unchanged: true,
    frames: [
      {
        case_id: "shape-ellipse",
        frame: 0,
        profile,
        status: passed ? "passed" : "failed",
        self_review_required: !passed,
        step: { status: passed ? "passed" : "failed", exit_code: passed ? 0 : 1 },
        evidence,
      },
    ],
    comparisons: [{ case_id: "shape-ellipse", frame: 0, comparison: value, evidence }],
    evidence: [evidence],
  };
  await f.json(`oracle/${side}.json`, {
    schema_version: 1,
    frames: [
      { case_id: "shape-ellipse", frame: 0, path: path.slice(7), png_sha256: candidate.png_sha256 },
    ],
  });
  await f.json(`oracle/${side}-g3.json`, gate);
  return { gate, candidate, value, evidence };
}

export async function oracle(f) {
  const pixels = Buffer.alloc(320 * 180 * 4, 100);
  await f.write("reference.png", encodeRgbaPng(320, 180, pixels));
  const original = {
    path: "reference.png",
    png_sha256: await f.hash("reference.png"),
    rgba_sha256: sha256(pixels),
    width: 320,
    height: 180,
    sequence: false,
    isolated: false,
  };
  const positive = await comparison(f, "positive", original, pixels, true);
  const broken = Buffer.from(pixels);
  for (let y = 70; y < 90; y++)
    for (let x = 145; x < 165; x++) broken.fill(0, (y * 320 + x) * 4, (y * 320 + x) * 4 + 4);
  const negative = await comparison(f, "negative", original, broken, false);
  const proof = {
    status: "passed",
    source_unchanged: true,
    source: { source_sha256: "a".repeat(64) },
    source_after: { source_sha256: "a".repeat(64) },
    perturbation: {
      case_id: "shape-ellipse",
      frame: 0,
      rectangle: [145, 70, 20, 20],
      changed_pixels: 400,
      replacement_rgba: [0, 0, 0, 0],
    },
    positive: positive.gate,
    negative: negative.gate,
  };
  await f.json("oracle/report.json", proof);
  const review = {
    ...negative.value,
    case_id: "shape-ellipse",
    frame: 0,
    profile: "gpu",
    purpose: "oracle-rejection-proof",
    residual_class: "structural",
    verdict: "rejected",
    evidence: negative.evidence,
  };
  return {
    references: new Map([["shape-ellipse/0", original]]),
    positive,
    negative,
    proof,
    ledger: { self_reviews: [review] },
    task: {
      oracle_rejection: { report: "oracle/report.json", comparison_evidence: negative.evidence },
    },
  };
}
