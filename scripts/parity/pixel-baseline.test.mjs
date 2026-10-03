import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hash, PixelInputs } from "./pixel-inputs.mjs";
import { encodeRgbaPng } from "./png.mjs";
import { digest } from "./provenance.mjs";

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-pixel-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = "a".repeat(64);
  const item = {
    id: "fixture",
    project: "project.json",
    composition: "main",
    frames: [1],
    size: { width: 1, height: 1 },
    tolerance: "exact",
    sequence: true,
  };
  const host = { cacheIdentity: { backend: "browser-webgpu", device: "fixture" } };
  const png = encodeRgbaPng(1, 1, Buffer.from([10, 20, 30, 255]));
  const projectPath = join(root, item.project);
  await json(projectPath, {
    compositions: [{ id: "main", duration: 3, frameRate: { numerator: 1, denominator: 1 } }],
  });
  const inputs = { case: item, project_sha256: hash(await readFile(projectPath)) };
  const caseHash = digest(inputs);
  const cacheKey = digest({ source, case: caseHash, adapter: host.cacheIdentity });
  const directory = join(root, "artifacts", "parity", "reference", item.id);
  const capture = {
    schema_version: 1,
    source_verified: true,
    case_id: item.id,
    inputs,
    cache_key: cacheKey,
    frames: [],
  };
  const metadata = [];
  for (const frame of [0, 1, 2]) {
    const meta = {
      case_id: item.id,
      frame,
      size: item.size,
      pixel_format: "rgba8",
      cache_key: cacheKey,
      case_sha256: caseHash,
      renderer_source_sha256: source,
      host: structuredClone(host),
      png_sha256: hash(png),
      rgba_sha256: "b".repeat(64),
    };
    metadata.push(meta);
    await json(join(directory, String(frame), "meta.json"), meta);
    await writeFile(join(directory, String(frame), "frame.png"), png);
    capture.frames.push({
      frame,
      png_sha256: hash(png),
      meta_sha256: hash(await readFile(join(directory, String(frame), "meta.json"))),
    });
  }
  await json(join(directory, "capture.json"), capture);
  await json(join(root, "tests", "parity", "corpus.json"), { cases: [item] });
  await json(join(root, "tests", "parity", "tolerances.json"), { schema_version: 1 });
  const ledgerPath = join(root, "docs", "migration", "rust-renderer-progress.json");
  const ledger = {
    reference_baseline: { renderer_source_sha256: source },
    milestones: [
      { id: "M0", tasks: [{ id: "M0-T3", reference_capture: { renderer_source_sha256: source } }] },
    ],
  };
  await json(ledgerPath, ledger);
  const manifestPath = join(root, "candidate", "manifest.json");
  await json(manifestPath, {
    schema_version: 1,
    frames: [{ case_id: item.id, frame: 1, path: "candidate.png", png_sha256: hash(png) }],
  });
  await writeFile(join(dirname(manifestPath), "candidate.png"), png);
  const load = async () => {
    const reader = new PixelInputs({ root });
    const [entry] = await reader.load(manifestPath, "full", null);
    return { reader, entry };
  };
  const rewrite = async () => {
    for (const meta of metadata) {
      const path = join(directory, String(meta.frame), "meta.json");
      await json(path, meta);
      capture.frames[meta.frame].meta_sha256 = hash(await readFile(path));
    }
    await json(join(directory, "capture.json"), capture);
  };
  return { source, metadata, capture, ledger, ledgerPath, load, rewrite };
}

test("reference baseline falls back to the approved M0-T3 capture only when no explicit pin exists", async (t) => {
  const data = await fixture(t);
  delete data.ledger.reference_baseline;
  await json(data.ledgerPath, data.ledger);
  const { reader, entry } = await data.load();
  await reader.prepare(entry);
  data.ledger.reference_baseline = { renderer_source_sha256: "c".repeat(64) };
  await json(data.ledgerPath, data.ledger);
  const replaced = await data.load();
  await assert.rejects(replaced.reader.prepare(replaced.entry), /approved baseline/);
});

test("missing or malformed approved source fails before reading references", async (t) => {
  const data = await fixture(t);
  for (const ledger of [{}, { reference_baseline: { renderer_source_sha256: "invalid" } }]) {
    await json(data.ledgerPath, ledger);
    await assert.rejects(data.load(), /approved reference renderer source/);
  }
});

test("a self-consistent replacement capture from another source cannot replace the approved oracle", async (t) => {
  const data = await fixture(t);
  for (const meta of data.metadata) {
    meta.renderer_source_sha256 = "f".repeat(64);
    meta.cache_key = digest({
      source: meta.renderer_source_sha256,
      case: meta.case_sha256,
      adapter: meta.host.cacheIdentity,
    });
  }
  data.capture.cache_key = data.metadata[0].cache_key;
  await data.rewrite();
  const { reader, entry } = await data.load();
  await assert.rejects(reader.prepare(entry), /approved baseline/);
});

test("sequence neighbors also require the approved source", async (t) => {
  const data = await fixture(t);
  data.metadata[2].renderer_source_sha256 = "f".repeat(64);
  await data.rewrite();
  const { reader, entry } = await data.load();
  await assert.rejects(reader.prepare(entry), /approved baseline/);
});

test("a rehashed metadata record cannot substitute a different host identity", async (t) => {
  const data = await fixture(t);
  data.metadata[1].host.cacheIdentity.device = "other-device";
  await data.rewrite();
  const { reader, entry } = await data.load();
  await assert.rejects(reader.prepare(entry), /cache key differs/);
});
