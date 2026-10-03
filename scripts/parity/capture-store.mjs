import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeAtomicJson } from "../migration/report.mjs";
import { hashFile } from "../migration/source.mjs";
import { encodeRgbaPng } from "./png.mjs";
import { digest } from "./provenance.mjs";

export class CaptureStore {
  constructor(config, host) {
    this.config = config;
    this.host = host;
    this.frames = new Map();
  }

  key(assignment) {
    return digest({
      source: this.config.source.renderer_source_sha256,
      case: assignment.caseHash,
      adapter: this.host.cacheIdentity ?? this.host,
    });
  }

  async cached(assignment) {
    if (this.config.force) return false;
    if (this.host.cacheIdentity?.fonts?.status !== "available") return false;
    const path = join(this.config.root, "artifacts", "parity", "reference", assignment.case.id);
    try {
      const record = JSON.parse(await readFile(join(path, "capture.json"), "utf8"));
      if (!record.source_verified || record.cache_key !== this.key(assignment)) return false;
      assert.deepEqual(
        record.frames.map((frame) => frame.frame),
        assignment.frames,
      );
      for (const frame of record.frames) {
        assert.equal(
          await hashFile(join(path, String(frame.frame), "frame.png")),
          frame.png_sha256,
        );
        assert.equal(
          await hashFile(join(path, String(frame.frame), "meta.json")),
          frame.meta_sha256,
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  async writeFrame(assignment, payload) {
    const item = assignment.case;
    assert(/^[a-z0-9-]+$/.test(item.id), "Unsafe case id");
    assert(Number.isSafeInteger(payload.frame) && payload.frame >= 0, "Invalid frame address");
    assert.equal(payload.caseId, item.id);
    assert.equal(payload.width, item.size.width);
    assert.equal(payload.height, item.size.height);
    assert(assignment.frames.includes(payload.frame), "Unrequested capture frame");
    assert.equal(
      payload.time,
      (payload.frame * payload.frameRate.denominator) / payload.frameRate.numerator,
    );
    const collected = this.frames.get(item.id) ?? new Map();
    assert(!collected.has(payload.frame), "Duplicate capture frame");
    const pixels =
      payload.pixels instanceof ArrayBuffer ? new Uint8Array(payload.pixels) : payload.pixels;
    assert.equal(pixels.byteLength, payload.width * payload.height * 4);
    const started = performance.now();
    const png = encodeRgbaPng(payload.width, payload.height, pixels);
    const path = join(this.config.runDirectory, "pending", item.id, String(payload.frame));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "frame.png"), png, { flag: "wx" });
    const meta = {
      schema_version: 1,
      case_id: item.id,
      frame: payload.frame,
      time: payload.time,
      frame_rate: payload.frameRate,
      size: item.size,
      aa: item.aa,
      requested: item.frames.includes(payload.frame),
      cache_key: this.key(assignment),
      case_sha256: assignment.caseHash,
      commit: this.config.source.commit,
      source_dirty: this.config.source.dirty,
      renderer_source_sha256: this.config.source.renderer_source_sha256,
      source_tree_sha256: this.config.source.tree_sha256,
      run_id: this.config.runId,
      adapter: payload.diagnostics,
      host: this.host,
      backend: this.host.backend ?? "browser-webgpu",
      pixel_format: "rgba8",
      png_sha256: createHash("sha256").update(png).digest("hex"),
      rgba_sha256: createHash("sha256").update(pixels).digest("hex"),
      timings: { ...payload.timings, png_encode_write_ms: performance.now() - started },
    };
    await writeAtomicJson(join(path, "meta.json"), meta);
    collected.set(payload.frame, {
      frame: payload.frame,
      png_sha256: meta.png_sha256,
      meta_sha256: await hashFile(join(path, "meta.json")),
    });
    this.frames.set(item.id, collected);
  }

  async completeCase(assignment, payload) {
    assert.equal(payload.caseId, assignment.case.id);
    const frames = this.frames.get(assignment.case.id);
    assert.equal(frames?.size, assignment.frames.length, "Case capture is incomplete");
    const ordered = assignment.frames.map((frame) => {
      assert(frames.has(frame), `Missing capture frame ${frame}`);
      return frames.get(frame);
    });
    await writeAtomicJson(
      join(this.config.runDirectory, "pending", assignment.case.id, "capture.json"),
      {
        schema_version: 1,
        cache_key: this.key(assignment),
        source_verified: false,
        case_id: assignment.case.id,
        frames: ordered,
        inputs: assignment.inputs,
        elapsed_ms: payload.elapsed_ms,
        diagnostics: payload.diagnostics,
      },
    );
  }

  async finish(report) {
    await writeAtomicJson(join(this.config.runDirectory, "report.json"), report);
  }
}

export async function publishCaptures(config, report) {
  assert.equal(report.status, "passed", "Cannot publish references from a failed capture run");
  assert.equal(report.source_unchanged, true, "Cannot publish references from changed inputs");
  for (const item of report.cases.filter((item) => item.status === "passed")) {
    const pending = join(config.runDirectory, "pending", item.id);
    const record = JSON.parse(await readFile(join(pending, "capture.json"), "utf8"));
    record.source_verified = true;
    await writeAtomicJson(join(pending, "capture.json"), record);
    const destination = join(config.root, "artifacts", "parity", "reference", item.id);
    await mkdir(join(config.root, "artifacts", "parity", "reference"), { recursive: true });
    const previous = join(config.runDirectory, "superseded", item.id);
    for (const path of [pending, destination, previous]) {
      const member = relative(resolve(config.root), resolve(path));
      assert(
        member && !member.startsWith("..") && !isAbsolute(member),
        "Capture publication escaped its workspace",
      );
    }
    const exists = await stat(destination)
      .then(() => true)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      });
    if (exists) {
      await mkdir(join(config.runDirectory, "superseded"), { recursive: true });
      await rename(destination, previous);
    }
    try {
      await rename(pending, destination);
    } catch (error) {
      if (exists) await rename(previous, destination);
      throw error;
    }
  }
}
