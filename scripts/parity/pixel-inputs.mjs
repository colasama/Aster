import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest } from "./provenance.mjs";
import { ReferenceRepairs } from "./reference-repairs.mjs";

export const profiles = ["exact", "gpu", "decode", "yuv", "perceptual"];
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function containedPath(base, name) {
  assert.equal(typeof name, "string", "Evidence path must be a string");
  const path = resolve(base, name);
  const member = relative(resolve(base), path);
  assert(
    member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member),
    "Path escapes its declared directory",
  );
  return path;
}

export class PixelInputs {
  #snapshots = new Map();
  #cases = new Map();
  #references = new Map();
  #projects = new Map();

  constructor(context) {
    this.context = context;
  }

  async bytes(path) {
    const canonical = await realpath(path);
    assert((await stat(canonical)).isFile(), "Capture input must be a regular file");
    const bytes = await readFile(canonical);
    const sha256 = hash(bytes);
    const logical = resolve(path);
    const previous = this.#snapshots.get(logical);
    assert(!previous || previous === sha256, `Input changed during comparison: ${path}`);
    this.#snapshots.set(logical, sha256);
    return { bytes, sha256 };
  }

  async json(path) {
    const { bytes } = await this.bytes(path);
    return JSON.parse(bytes.toString("utf8"));
  }

  async load(manifestPath, scope, profileOverride) {
    assert(["full", "diagnostic"].includes(scope), "Unknown pixel gate scope");
    assert(
      profileOverride === null || profiles.includes(profileOverride),
      "Unknown tolerance profile override",
    );
    this.corpus = await this.json(join(this.context.root, "tests", "parity", "corpus.json"));
    this.ledger = await this.json(
      join(this.context.root, "docs", "migration", "rust-renderer-progress.json"),
    );
    this.referenceSource =
      this.ledger.reference_baseline?.renderer_source_sha256 ??
      this.ledger.milestones
        ?.find((milestone) => milestone.id === "M0")
        ?.tasks?.find((task) => task.id === "M0-T3")?.reference_capture?.renderer_source_sha256;
    assert(
      /^[a-f0-9]{64}$/.test(this.referenceSource),
      "An approved reference renderer source SHA-256 is required",
    );
    const catalog = await this.bytes(join(this.context.root, "tests", "parity", "tolerances.json"));
    this.catalogHash = catalog.sha256;
    this.catalog = JSON.parse(catalog.bytes.toString("utf8"));
    assert.equal(this.catalog.schema_version, 1, "Unknown tolerance catalog schema");
    let required = 0;
    for (const item of this.corpus.cases) {
      assert(
        /^[a-z0-9-]+$/.test(item.id) && !this.#cases.has(item.id),
        "Invalid or duplicate corpus case",
      );
      assert(
        Array.isArray(item.frames) &&
          item.frames.length > 0 &&
          new Set(item.frames).size === item.frames.length,
        "Invalid corpus frame list",
      );
      assert(
        item.frames.every((frame) => Number.isSafeInteger(frame) && frame >= 0),
        "Invalid corpus frame address",
      );
      assert(profiles.includes(item.tolerance), "Unknown corpus tolerance profile");
      this.#cases.set(item.id, item);
      required += item.frames.length;
    }
    this.requiredCount = required;
    const manifest = await this.json(manifestPath);
    assert.equal(manifest.schema_version, 1, "Unknown candidate manifest schema");
    assert(
      Array.isArray(manifest.frames) && manifest.frames.length > 0,
      "Candidate manifest has no frames",
    );
    const seen = new Set();
    const entries = manifest.frames.map((entry) => {
      const item = this.#cases.get(entry.case_id);
      assert(item?.frames.includes(entry.frame), "Candidate contains an unknown case or frame");
      const key = `${entry.case_id}/${entry.frame}`;
      assert(!seen.has(key), "Candidate manifest contains a duplicate frame");
      seen.add(key);
      assert(/^[a-f0-9]{64}$/.test(entry.png_sha256), "Candidate PNG SHA-256 is required");
      assert(
        typeof entry.path === "string" && !isAbsolute(entry.path),
        "Candidate paths must be manifest-relative",
      );
      const path = containedPath(dirname(resolve(manifestPath)), entry.path);
      const profile = profileOverride ?? item.tolerance;
      assert(
        scope !== "full" || profile === "exact" || profile === item.tolerance,
        "A full gate cannot override a case with a different non-exact profile",
      );
      return { ...entry, path, item, profile };
    });
    if (scope === "full")
      assert.equal(seen.size, required, "Full candidate manifest is missing required frames");
    this.repairs = new ReferenceRepairs(this, manifest);
    this.requiredCount = required;
    return entries;
  }

  async projectComposition(item, reference) {
    if (this.#projects.has(item.id)) return this.#projects.get(item.id);
    const requested =
      item.project === "env:ASTER_PERF_PROJECT"
        ? (this.context.env?.ASTER_PERF_PROJECT ??
          (process.platform === "win32" ? "D:\\code\\SD04PV" : ""))
        : containedPath(this.context.root, item.project);
    assert(requested, "Owner performance project is unavailable");
    const path = (await stat(requested)).isDirectory()
      ? join(requested, "project.json")
      : requested;
    const content = await this.bytes(path);
    assert.equal(
      content.sha256,
      reference.inputs.project_sha256,
      "Current project no longer matches the captured reference",
    );
    const project = JSON.parse(content.bytes.toString("utf8"));
    const composition = project.compositions.find((value) => value.id === item.composition);
    assert(composition, "Corpus composition is absent from its project");
    this.#projects.set(item.id, composition);
    return composition;
  }

  async baseReference(item, frame) {
    const directory = join(this.context.root, "artifacts", "parity", "reference", item.id);
    let capture = this.#references.get(item.id);
    if (!capture) {
      capture = await this.json(join(directory, "capture.json"));
      assert.equal(capture.schema_version, 1, "Unknown reference capture schema");
      assert.equal(
        capture.source_verified,
        true,
        "Reference capture was not published from verified source",
      );
      assert.equal(capture.case_id, item.id, "Reference case identity differs");
      assert(
        isDeepStrictEqual(capture.inputs?.case, item),
        "Reference corpus case differs from the requested case",
      );
      assert(
        Array.isArray(capture.frames) &&
          new Set(capture.frames.map((entry) => entry.frame)).size === capture.frames.length,
        "Reference frame index is invalid",
      );
      this.#references.set(item.id, capture);
    }
    const record = capture.frames.find((entry) => entry.frame === frame);
    assert(record, `Missing reference ${item.id}/${frame}`);
    const path = join(directory, String(frame), "frame.png");
    const png = await this.bytes(path);
    const metadata = await this.bytes(join(directory, String(frame), "meta.json"));
    assert.equal(png.sha256, record.png_sha256, "Reference PNG SHA-256 differs from its capture");
    assert.equal(
      metadata.sha256,
      record.meta_sha256,
      "Reference metadata SHA-256 differs from its capture",
    );
    const meta = JSON.parse(metadata.bytes.toString("utf8"));
    assert.equal(meta.case_id, item.id);
    assert.equal(meta.frame, frame);
    assert.equal(meta.png_sha256, png.sha256);
    assert.equal(meta.case_sha256, digest(capture.inputs));
    assert.equal(
      meta.renderer_source_sha256,
      this.referenceSource,
      "Reference renderer source differs from the approved baseline",
    );
    assert(meta.host && typeof meta.host === "object", "Reference host identity is absent");
    assert.equal(
      meta.cache_key,
      digest({
        source: this.referenceSource,
        case: meta.case_sha256,
        adapter: meta.host.cacheIdentity ?? meta.host,
      }),
      "Reference cache key differs from its source, case, or host identity",
    );
    assert.equal(meta.cache_key, capture.cache_key);
    assert.equal(meta.pixel_format, "rgba8");
    assert(isDeepStrictEqual(meta.size, item.size), "Reference dimensions differ from the corpus");
    assert(/^[a-f0-9]{64}$/.test(meta.rgba_sha256), "Reference RGBA SHA-256 is absent");
    return { path, png_sha256: png.sha256, meta_sha256: metadata.sha256, meta, capture };
  }

  async reference(item, frame) {
    const original = await this.baseReference(item, frame);
    return this.repairs.resolve(item, frame, original);
  }

  referenceBinding() {
    return {
      base_renderer_source_sha256: this.referenceSource ?? null,
      repairs_sha256: digest(this.ledger?.reference_repairs ?? []),
      repairs: this.repairs?.evidence ?? [],
    };
  }

  async prepare(entry) {
    const reference = await this.reference(entry.item, entry.frame);
    const [candidatePath, referencePath] = await Promise.all([
      realpath(entry.path),
      realpath(reference.path),
    ]);
    assert.notEqual(
      candidatePath,
      referencePath,
      "Candidate and effective reference must be independent files",
    );
    assert.equal(
      (await this.bytes(entry.path)).sha256,
      entry.png_sha256,
      "Candidate PNG SHA-256 differs from manifest",
    );
    const composition = await this.projectComposition(entry.item, reference.capture);
    const context = {
      case_id: entry.case_id,
      isolated: Boolean(entry.item.isolated),
      background: null,
      sequence: null,
    };
    if (context.isolated) {
      assert(
        isDeepStrictEqual(composition.background, [0, 0, 0, 0]),
        "Isolated ink bounds currently require an explicit transparent project background",
      );
      context.background = [0, 0, 0, 0];
    }
    const neighbors = {};
    if (entry.item.sequence) {
      const rate = composition.frameRate;
      assert(
        Number.isFinite(composition.duration) &&
          composition.duration > 0 &&
          Number.isSafeInteger(rate?.numerator) &&
          rate.numerator > 0 &&
          Number.isSafeInteger(rate.denominator) &&
          rate.denominator > 0,
        "Invalid sequence time domain",
      );
      const last = Math.ceil((composition.duration * rate.numerator) / rate.denominator) - 1;
      assert(
        Number.isSafeInteger(last) && entry.frame <= last,
        "Sequence frame is outside its project time domain",
      );
      for (const [name, frame] of [
        ["previous", entry.frame - 1],
        ["next", entry.frame + 1],
      ]) {
        if (frame >= 0 && frame <= last) neighbors[name] = await this.reference(entry.item, frame);
      }
      context.sequence = {
        frame: entry.frame,
        first_frame: 0,
        last_frame: last,
        previous: neighbors.previous?.path ?? null,
        next: neighbors.next?.path ?? null,
      };
    }
    return { entry, reference, context, neighbors };
  }

  async verifyStable() {
    for (const [path, expected] of this.#snapshots) {
      assert.equal(
        hash(await readFile(path)),
        expected,
        `Input changed during comparison: ${path}`,
      );
    }
    return this.#snapshots.size;
  }
}
