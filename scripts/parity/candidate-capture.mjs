import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { writeAtomicJson } from "../migration/report.mjs";
import { hashFile } from "../migration/source.mjs";
import { validateFrameArtifacts } from "./frame-artifacts.mjs";
import { decodeRgbaPng } from "./png.mjs";
import { digest } from "./provenance.mjs";
import { validateCapturedRaster } from "./raster-capture.mjs";

async function stagedFile(directory, ...parts) {
  const path = await realpath(join(directory, ...parts));
  const member = relative(directory, path);
  assert(
    member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member),
    "Candidate input escapes its staging directory",
  );
  assert((await lstat(path)).isFile(), "Candidate input must be a regular file");
  return path;
}

/** Publish a fresh capture as an isolated, whole-run candidate; references are never read or moved. */
export async function publishCandidateCapture(config, report) {
  assert(!config.planReferences, "Plan-only captures must never publish pixel candidates");
  assert.equal(config.candidate, true, "Candidate publication requires candidate mode");
  assert.equal(report.status, "passed", "Cannot publish a failed candidate capture");
  assert.equal(report.source_unchanged, true, "Candidate source or inputs changed");
  assert.equal(report.exit_code, 0, "Candidate renderer process did not exit successfully");
  assert.equal(report.run_id, config.runId, "Candidate run identity differs");
  assert.deepEqual(report.source, config.source, "Candidate source provenance differs");
  for (const key of ["renderer_source_sha256", "tree_sha256"]) {
    assert(/^[a-f0-9]{64}$/.test(config.source[key]), "Candidate source SHA-256 is required");
    assert.equal(report.source_after?.[key], config.source[key], "Candidate source changed");
  }
  assert(report.host?.cacheIdentity, "Candidate host identity is missing");
  assert(/^[a-z0-9-]+$/i.test(config.runId), "Unsafe candidate run id");
  const root = await realpath(config.root);
  const expectedRun = join(root, "artifacts", "parity", "runs", config.runId);
  const directory = await realpath(config.runDirectory);
  assert.equal(
    relative(expectedRun, directory),
    "",
    "Candidate publication must stay inside its independent run directory",
  );
  const pending = await realpath(join(directory, "pending"));
  assert.equal(
    relative(join(directory, "pending"), pending),
    "",
    "Candidate staging was redirected",
  );
  const destination = join(directory, "candidate");
  const lockPath = join(directory, ".candidate.lock");
  const lock = await open(lockPath, "wx");
  try {
    await assert.rejects(lstat(destination), { code: "ENOENT" }, "Candidate output already exists");
    const corpusPath = join(root, "tests", "parity", "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    const cases = new Map(corpus.cases.map((item) => [item.id, item]));
    assert.equal(cases.size, corpus.cases.length, "Duplicate corpus case");
    const selected = config.assignments.map((item) => item.case.id);
    assert(selected.length > 0, "Candidate assignments are empty");
    assert.equal(new Set(selected).size, selected.length, "Duplicate candidate assignment");
    assert.deepEqual(report.selected_cases, selected, "Candidate selected cases differ");
    assert.deepEqual(
      report.cases.map((item) => item.id).sort(),
      [...selected].sort(),
      "Candidate capture did not complete all assignments",
    );
    assert(
      report.cases.every((item) => item.status === "passed"),
      "Candidate capture must freshly render every case without reference caching",
    );
    const manifest = {
      schema_version: 1,
      kind: "ts-candidate",
      source_verified: true,
      run_id: config.runId,
      scope: selected.length === corpus.cases.length ? "full" : "diagnostic",
      source: config.source,
      source_after: report.source_after,
      host: report.host,
      corpus_sha256: await hashFile(corpusPath),
      required_case_count: corpus.cases.length,
      required_frame_count: corpus.cases.reduce((sum, item) => sum + item.frames.length, 0),
      captured_frame_count: 0,
      selected_cases: selected,
      cases: [],
      frames: [],
    };
    for (const assignment of config.assignments) {
      const item = assignment.case;
      assert(/^[a-z0-9-]+$/.test(item.id), "Unsafe candidate case id");
      assert.deepEqual(item, cases.get(item.id), "Candidate case differs from the corpus");
      assert(!assignment.unavailable, "Candidate resources are unavailable");
      assert.deepEqual(assignment.inputs.case, item, "Candidate inputs describe another case");
      assert.equal(assignment.caseHash, digest(assignment.inputs), "Candidate input hash differs");
      assert.deepEqual(assignment.frames, assignment.inputs.frames);
      assert.equal(new Set(assignment.frames).size, assignment.frames.length, "Duplicate frame");
      assert(
        item.frames.every((frame) => assignment.frames.includes(frame)),
        "Missing requested frame",
      );
      const capturePath = await stagedFile(pending, item.id, "capture.json");
      const capture = JSON.parse(await readFile(capturePath, "utf8"));
      const cacheKey = digest({
        source: config.source.renderer_source_sha256,
        case: assignment.caseHash,
        adapter: report.host.cacheIdentity,
      });
      assert.equal(capture.schema_version, 1);
      assert.equal(capture.source_verified, false, "Candidate case was already published");
      assert.equal(capture.case_id, item.id);
      assert.equal(capture.cache_key, cacheKey);
      assert.deepEqual(capture.inputs, assignment.inputs);
      assert.deepEqual(
        capture.frames.map((frame) => frame.frame),
        assignment.frames,
      );
      const rasterHashes = new Set();
      for (const raster of capture.raster_resources ?? []) {
        assert(/^[a-f0-9]{64}$/.test(raster.pixel_hash));
        assert(!rasterHashes.has(raster.pixel_hash));
        rasterHashes.add(raster.pixel_hash);
        const messagesPath = await stagedFile(
          pending,
          item.id,
          "raster-resources",
          `${raster.pixel_hash}.json`,
        );
        const pixelsPath = await stagedFile(
          pending,
          item.id,
          "raster-resources",
          `${raster.pixel_hash}.bin`,
        );
        assert.equal(await hashFile(messagesPath), raster.messages_sha256);
        assert.equal(await hashFile(pixelsPath), raster.pixels_sha256);
        const pixels = await readFile(pixelsPath);
        const checked = validateCapturedRaster(
          JSON.parse(await readFile(messagesPath, "utf8")),
          pixels,
          pixels,
        );
        for (const [key, value] of Object.entries(checked)) assert.equal(raster[key], value);
      }
      const frameResources = new Map();
      for (const record of capture.frames) {
        assert(Number.isSafeInteger(record.frame) && record.frame >= 0, "Unsafe candidate frame");
        const pngPath = await stagedFile(pending, item.id, String(record.frame), "frame.png");
        const metaPath = await stagedFile(pending, item.id, String(record.frame), "meta.json");
        assert.equal(await hashFile(pngPath), record.png_sha256, "Candidate PNG hash differs");
        assert.equal(
          await hashFile(metaPath),
          record.meta_sha256,
          "Candidate metadata hash differs",
        );
        const meta = JSON.parse(await readFile(metaPath, "utf8"));
        if (config.requireFrameBundles || meta.frame_plan)
          await validateFrameArtifacts(
            async (path) => readFile(await stagedFile(pending, item.id, path)),
            meta,
            item,
            config.source,
            frameResources,
          );
        if (meta.raster_resources !== undefined)
          for (const hash of meta.raster_resources)
            assert(rasterHashes.has(hash), "Unknown captured raster reference");
        assert.equal(meta.schema_version, 1);
        assert.equal(meta.case_id, item.id);
        assert.equal(meta.frame, record.frame);
        assert.equal(meta.run_id, config.runId);
        assert.equal(meta.renderer_source_sha256, config.source.renderer_source_sha256);
        assert.equal(meta.source_tree_sha256, config.source.tree_sha256);
        assert.equal(meta.case_sha256, assignment.caseHash);
        assert.equal(meta.cache_key, cacheKey);
        assert.equal(meta.png_sha256, record.png_sha256);
        assert.equal(meta.pixel_format, "rgba8");
        assert.deepEqual(meta.size, item.size);
        assert.equal(meta.aa, item.aa);
        assert.deepEqual(meta.host, report.host);
        assert.equal(meta.requested, item.frames.includes(record.frame));
        assert(
          Number.isSafeInteger(meta.frame_rate?.numerator) &&
            meta.frame_rate.numerator > 0 &&
            Number.isSafeInteger(meta.frame_rate?.denominator) &&
            meta.frame_rate.denominator > 0,
          "Candidate rational frame rate is invalid",
        );
        assert.equal(
          meta.time,
          (record.frame * meta.frame_rate.denominator) / meta.frame_rate.numerator,
        );
        const image = decodeRgbaPng(await readFile(pngPath));
        assert.equal(image.width, item.size.width);
        assert.equal(image.height, item.size.height);
        // The raw checksum also binds hidden RGB bytes of transparent pixels.
        assert.equal(createHash("sha256").update(image.pixels).digest("hex"), meta.rgba_sha256);
        if (meta.requested)
          manifest.frames.push({
            case_id: item.id,
            frame: record.frame,
            path: `${item.id}/${record.frame}/frame.png`,
            png_sha256: record.png_sha256,
            meta_path: `${item.id}/${record.frame}/meta.json`,
            meta_sha256: record.meta_sha256,
            rgba_sha256: meta.rgba_sha256,
          });
      }
      capture.source_verified = true;
      await writeAtomicJson(capturePath, capture);
      manifest.captured_frame_count += capture.frames.length;
      manifest.cases.push({
        case_id: item.id,
        case_sha256: assignment.caseHash,
        path: `${item.id}/capture.json`,
        capture_sha256: await hashFile(capturePath),
        requested_frames: item.frames,
        captured_frames: assignment.frames,
      });
    }
    const manifestPath = join(pending, "manifest.json");
    await writeAtomicJson(manifestPath, manifest);
    const manifestHash = await hashFile(manifestPath);
    // The complete bundle becomes visible in one rename; failures leave only unpublished staging.
    await rename(pending, destination);
    return {
      manifest: relative(root, join(destination, "manifest.json")).split(sep).join("/"),
      manifest_sha256: manifestHash,
      scope: manifest.scope,
      case_count: manifest.cases.length,
      requested_frame_count: manifest.frames.length,
      captured_frame_count: manifest.captured_frame_count,
    };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
