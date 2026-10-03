import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { decodeRgbaPng } from "../parity/png.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function validSha(value) {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Evidence SHA-256 is required");
  return value;
}
export function evidencePath(value) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      !isAbsolute(value) &&
      !/[\\:]/.test(value) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "Evidence paths must be safe checkout-relative paths",
  );
  return value;
}
export class M0Evidence {
  #snapshots = new Map();
  constructor(root) {
    this.root = resolve(root);
  }
  async bytes(name, expected) {
    const logical = resolve(this.root, evidencePath(name));
    const path = await realpath(logical);
    const member = relative(await realpath(this.root), path);
    assert(
      member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member),
      "Evidence escaped the checkout",
    );
    const bytes = await readFile(path);
    const hash = sha256(bytes);
    if (expected !== undefined)
      assert.equal(hash, validSha(expected), `Evidence SHA-256 differs: ${name}`);
    if (this.#snapshots.has(logical))
      assert.equal(hash, this.#snapshots.get(logical), "Evidence changed during audit");
    this.#snapshots.set(logical, hash);
    return { bytes, sha256: hash };
  }
  async json(name, expected) {
    return JSON.parse((await this.bytes(name, expected)).bytes.toString("utf8"));
  }
  async image(name, expected) {
    const file = await this.bytes(name, expected);
    const image = decodeRgbaPng(file.bytes);
    return { ...image, png_sha256: file.sha256, rgba_sha256: sha256(image.pixels) };
  }
  async stable() {
    for (const [path, hash] of this.#snapshots)
      assert.equal(sha256(await readFile(path)), hash, "Evidence changed during audit");
    return this.#snapshots.size;
  }
}

export function stableSource(before, after, sourceField) {
  validSha(before?.[sourceField]);
  assert.equal(
    before[sourceField],
    after?.[sourceField],
    "Evidence source changed during execution",
  );
  if (sourceField === "renderer_source_sha256") {
    validSha(before.tree_sha256);
    assert.equal(before.tree_sha256, after.tree_sha256);
  }
}
