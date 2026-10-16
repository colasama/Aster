import { encodeRgbaPng } from "../parity/png.mjs";
import { digest } from "../parity/provenance.mjs";
import { auditCaptureSet } from "./m0-captures.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { fixture } from "./m0-exit-fixtures.mjs";

/** Portable evidence chain, including preserved failed comparisons and unaffected later frames. */
export async function materialReferenceFixture(t) {
  const f = await fixture(t);
  const kind = "material-ready-first-frame-reference-repair-v1";
  const ids = ["scene-lighting-directional", "scene-lighting-point", "scene-lighting-spot"];
  const corpus = {
    cases: ids.map((id) => ({
      id,
      project: "project.json",
      composition: "main",
      frames: [0, 15, 30, 59],
      size: { width: 2, height: 2 },
      aa: "off",
      tolerance: "gpu",
    })),
  };
  await f.json("tests/parity/corpus.json", corpus);
  const source = { renderer_source_sha256: "a".repeat(64), tree_sha256: "b".repeat(64) };
  const host = { cacheIdentity: { device: "fixture" } };
  const manifest = {
    schema_version: 1,
    kind: "ts-candidate",
    scope: "diagnostic",
    source_verified: true,
    run_id: "material-repair",
    source,
    source_after: source,
    host,
    corpus_sha256: await f.hash("tests/parity/corpus.json"),
    selected_cases: ids,
    required_case_count: 3,
    required_frame_count: 12,
    captured_frame_count: 12,
    cases: [],
    frames: [],
  };
  for (const directory of ["refs", "candidate"]) {
    for (const item of corpus.cases) {
      const inputs = { case: item, frames: item.frames };
      const cache_key = digest({
        source: source.renderer_source_sha256,
        case: digest(inputs),
        adapter: host.cacheIdentity,
      });
      const capture = {
        schema_version: 1,
        source_verified: true,
        case_id: item.id,
        cache_key,
        inputs,
        frames: [],
      };
      for (const frame of item.frames) {
        const prefix = `${directory}/${item.id}/${frame}`;
        const pixels = Buffer.alloc(16, 100);
        if (directory === "candidate" && frame === 0) pixels[0] = 130;
        const png = encodeRgbaPng(2, 2, pixels);
        await f.write(`${prefix}/frame.png`, png);
        const meta = {
          case_id: item.id,
          frame,
          requested: true,
          renderer_source_sha256: source.renderer_source_sha256,
          source_tree_sha256: source.tree_sha256,
          run_id: manifest.run_id,
          case_sha256: digest(inputs),
          cache_key,
          host,
          pixel_format: "rgba8",
          png_sha256: sha256(png),
          rgba_sha256: sha256(pixels),
          size: item.size,
          aa: item.aa,
          frame_rate: { numerator: 30, denominator: 1 },
          time: frame / 30,
        };
        await f.json(`${prefix}/meta.json`, meta);
        const meta_sha256 = await f.hash(`${prefix}/meta.json`);
        capture.frames.push({ frame, png_sha256: meta.png_sha256, meta_sha256 });
        if (directory === "candidate")
          manifest.frames.push({
            case_id: item.id,
            frame,
            path: `${item.id}/${frame}/frame.png`,
            meta_path: `${item.id}/${frame}/meta.json`,
            png_sha256: meta.png_sha256,
            rgba_sha256: meta.rgba_sha256,
            meta_sha256,
          });
      }
      await f.json(`${directory}/${item.id}/capture.json`, capture);
      if (directory === "candidate")
        manifest.cases.push({
          case_id: item.id,
          case_sha256: digest(inputs),
          path: `${item.id}/capture.json`,
          capture_sha256: await f.hash(`${directory}/${item.id}/capture.json`),
          requested_frames: item.frames,
          captured_frames: item.frames,
        });
    }
  }
  await f.json("candidate/manifest.json", manifest);
  const report = {
    status: "passed",
    exit_code: 0,
    source_unchanged: true,
    run_id: manifest.run_id,
    source,
    source_after: source,
    host,
    capture_mode: "candidate",
    cases: ids.map((id) => ({ id, status: "passed" })),
    candidate: {
      manifest: "candidate/manifest.json",
      manifest_sha256: await f.hash("candidate/manifest.json"),
      scope: "diagnostic",
      case_count: 3,
      requested_frame_count: 12,
      captured_frame_count: 12,
    },
  };
  await f.json("capture-report.json", report);
  const original = await auditCaptureSet(f.reader(), corpus, "refs", source.renderer_source_sha256);
  const proposal = { kind, affected: [] },
    reviews = [],
    definitions = [];
  for (const id of ids) {
    const before = original.frames.get(`${id}/0`),
      after = manifest.frames.find((frame) => frame.case_id === id && frame.frame === 0);
    proposal.affected.push({
      case_id: id,
      frame: 0,
      original: { sha256: before.png_sha256 },
      candidate_rgba_sha256: after.rgba_sha256,
    });
    const evidence = {
      report: `review/${id}.json`,
      heatmap: `review/${id}-heatmap.png`,
      contact_sheet: `review/${id}-contact.png`,
    };
    await f.json(evidence.report, {
      comparison: {
        passed: false,
        reference_rgba_sha256: before.rgba_sha256,
        candidate_rgba_sha256: after.rgba_sha256,
      },
    });
    for (const name of ["heatmap", "contact_sheet"])
      await f.write(evidence[name], encodeRgbaPng(2, 2, Buffer.alloc(16)));
    for (const name of ["report", "heatmap", "contact_sheet"])
      evidence[`${name}_sha256`] = await f.hash(evidence[name]);
    reviews.push({ verdict: "rejected", residual_class: "structural", evidence });
    definitions.push({
      kind,
      case_id: id,
      frame: 0,
      directory: "candidate",
      candidate_manifest: "candidate/manifest.json",
      candidate_manifest_sha256: await f.hash("candidate/manifest.json"),
      capture_report: "capture-report.json",
      capture_report_sha256: await f.hash("capture-report.json"),
      renderer_source_sha256: source.renderer_source_sha256,
      approval_review: evidence.report,
    });
  }
  await f.json("proposal.json", proposal);
  const ledger = {
    owner_overrides: {
      material_reference_policy: {
        kind,
        approved: true,
        preserve_originals: true,
        other_quality_limits_unchanged: true,
        allowed_frames: ids.map((id) => `${id}/0`),
        proposal: { path: "proposal.json", sha256: await f.hash("proposal.json") },
      },
    },
    reference_repairs: definitions,
    self_reviews: reviews,
  };
  return { ...f, corpus, manifest, report, original, proposal, ledger, definitions };
}
