import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { evidencePath, validSha } from "../migration/m0-evidence.mjs";
import { auditReferenceRepairs } from "../migration/m0-reference-repairs.mjs";
import { decodeRgbaPng } from "./png.mjs";

/** Adapts the shared read-only audit to the comparator's input-stability snapshots. */
class RepairEvidence {
  constructor(inputs) {
    this.inputs = inputs;
    this.root = resolve(inputs.context.root);
  }

  async bytes(name, expected) {
    const logical = join(this.root, evidencePath(name));
    const path = await realpath(logical);
    const member = relative(await realpath(this.root), path);
    assert(
      member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member),
      "Repair evidence escaped the checkout",
    );
    const file = await this.inputs.bytes(logical);
    if (expected !== undefined)
      assert.equal(file.sha256, validSha(expected), "Repair evidence SHA-256 differs");
    return file;
  }

  async json(name, expected) {
    return JSON.parse((await this.bytes(name, expected)).bytes.toString("utf8"));
  }

  async image(name, expected) {
    const file = await this.bytes(name, expected);
    const image = decodeRgbaPng(file.bytes);
    return {
      ...image,
      png_sha256: file.sha256,
      rgba_sha256: createHash("sha256").update(image.pixels).digest("hex"),
    };
  }
}

/** A repair changes one explicitly approved address; its original and neighbors remain evidence. */
export class ReferenceRepairs {
  #inputs;
  #candidate;
  #records = new Map();
  #validated;
  #resolved = new Map();
  evidence = [];

  constructor(inputs, candidate) {
    this.#inputs = inputs;
    this.#candidate = candidate;
    const repairs = inputs.ledger.reference_repairs ?? [];
    assert(Array.isArray(repairs), "Reference repairs must be an array");
    for (const repair of repairs) {
      const item = inputs.corpus.cases.find((item) => item.id === repair.case_id);
      const key = `${repair.case_id}/${repair.frame}`;
      assert(
        item?.frames.includes(repair.frame) && !this.#records.has(key),
        "Reference repair must name a unique requested corpus frame",
      );
      for (const field of ["directory", "capture_report", "candidate_manifest", "approval_review"])
        evidencePath(repair[field]);
      assert.equal(repair.candidate_manifest, `${repair.directory}/manifest.json`);
      validSha(repair.renderer_source_sha256);
      this.#records.set(key, repair);
    }
  }

  async #audit() {
    const inputs = this.#inputs;
    const reader = new RepairEvidence(inputs);
    const originals = new Map();
    for (const repair of this.#records.values()) {
      const item = inputs.corpus.cases.find((item) => item.id === repair.case_id);
      const original = await inputs.baseReference(item, repair.frame);
      const composition = await inputs.projectComposition(item, original.capture);
      const domain = item.sequence
        ? {
            first_frame: 0,
            last_frame:
              Math.ceil(
                (composition.duration * composition.frameRate.numerator) /
                  composition.frameRate.denominator,
              ) - 1,
          }
        : null;
      const frames = item.sequence
        ? [repair.frame, repair.frame - 1, repair.frame + 1].filter(
            (frame) => frame >= domain.first_frame && frame <= domain.last_frame,
          )
        : [repair.frame];
      for (const frame of frames) {
        const value = await inputs.baseReference(item, frame);
        const path = relative(reader.root, value.path).split(sep).join("/");
        const image = await reader.image(path, value.png_sha256);
        assert.equal(
          image.rgba_sha256,
          value.meta.rgba_sha256,
          "Original repair RGBA hash differs",
        );
        originals.set(`${item.id}/${frame}`, {
          path,
          metaPath: relative(reader.root, join(dirname(value.path), "meta.json"))
            .split(sep)
            .join("/"),
          png_sha256: value.png_sha256,
          meta_sha256: value.meta_sha256,
          rgba_sha256: image.rgba_sha256,
          width: image.width,
          height: image.height,
          case_sha256: value.meta.case_sha256,
          sequence: Boolean(item.sequence),
          sequenceDomain: domain,
          isolated: Boolean(item.isolated),
        });
      }
    }
    const result = await auditReferenceRepairs(
      reader,
      inputs.ledger,
      inputs.corpus,
      originals,
      inputs.catalogHash,
    );
    this.evidence = result.repairs;
    if (this.#candidate.kind === "ts-candidate") {
      assert(
        typeof this.#candidate.run_id === "string" && this.#candidate.run_id.length > 0,
        "TS candidate run identity is missing",
      );
      assert(
        result.repairs.every((repair) => repair.run_id !== this.#candidate.run_id),
        "TS candidate must come from a different capture run than its reference repairs",
      );
    }
    for (const repair of this.#records.values()) {
      const key = `${repair.case_id}/${repair.frame}`;
      const value = result.effective.get(key);
      assert(value, "Approved reference repair did not resolve");
      const meta = await reader.json(value.metaPath, value.meta_sha256);
      const capture = await reader.json(`${repair.directory}/${repair.case_id}/capture.json`);
      this.#resolved.set(key, {
        path: resolve(reader.root, value.path),
        png_sha256: value.png_sha256,
        meta_sha256: value.meta_sha256,
        meta,
        capture,
      });
    }
  }

  async resolve(item, frame, original) {
    if (!this.#records.size) return original;
    this.#validated ??= this.#audit();
    await this.#validated;
    return this.#resolved.get(`${item.id}/${frame}`) ?? original;
  }
}
