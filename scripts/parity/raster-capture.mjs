import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

export function validateCapturedRaster(messages, pixels, replay) {
  assert.equal(messages.length, 3, "Raster capture requires source, frame and pixels");
  const [source, frame, payload] = messages;
  assert.equal(source.kind, "media_source");
  assert.equal(source.descriptor.media_kind, "raster");
  assert.equal(frame.kind, "media_frame");
  assert.equal(frame.descriptor.source, source.hash);
  assert.equal(frame.descriptor.sample.kind, "raster");
  assert(["text", "svg", "psd"].includes(frame.descriptor.sample.origin));
  assert.equal(payload.kind, "raster_pixels");
  assert.equal(payload.descriptor.frame, frame.hash);
  for (const key of ["width", "height", "format"])
    assert.equal(payload.descriptor[key], frame.descriptor[key]);
  for (const key of ["width", "height"])
    assert(
      Number.isInteger(payload.descriptor[key]) &&
        payload.descriptor[key] > 0 &&
        payload.descriptor[key] <= 16384,
    );
  assert.equal(payload.descriptor.format, "rgba8unorm-srgb");
  assert.equal(pixels.byteLength, payload.descriptor.width * payload.descriptor.height * 4);
  assert(pixels.byteLength <= 256 * 1024 * 1024, "Raster payload exceeds capture budget");
  assert.deepEqual(replay, pixels, "GPU replay pixels differ");
  for (const message of messages) {
    assert.equal(message.type, "put_resource");
    assert(/^[a-f0-9]{64}$/.test(message.hash));
    const json = Buffer.from(canonical({ kind: message.kind, descriptor: message.descriptor }));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(json.length);
    const hash = createHash("sha256").update("ASTER_RESOURCE_V1\0").update(length).update(json);
    if (message.kind === "raster_pixels") hash.update(pixels);
    assert.equal(hash.digest("hex"), message.hash, "Captured resource hash mismatch");
  }
  return {
    frame_hash: frame.hash,
    pixel_hash: payload.hash,
    origin: frame.descriptor.sample.origin,
    bytes: pixels.length,
    pixels_sha256: sha(pixels),
    replay_sha256: sha(replay),
  };
}

export class RasterCaptureStore {
  #cases = new Map();
  async write(directory, caseId, capture) {
    if (capture === undefined) return undefined;
    assert(Array.isArray(capture.references) && Array.isArray(capture.resources));
    const records = this.#cases.get(caseId) ?? new Map();
    let bytes = 0;
    for (const item of capture.resources) {
      const pixels = Buffer.from(item.pixels);
      const replay = Buffer.from(item.replay);
      bytes += pixels.length;
      assert(bytes <= 256 * 1024 * 1024 && records.size < 65536);
      const record = validateCapturedRaster(item.messages, pixels, replay);
      assert(!records.has(record.pixel_hash), "Duplicate captured raster payload");
      const target = join(directory, "raster-resources");
      await mkdir(target, { recursive: true });
      const messages = Buffer.from(JSON.stringify(item.messages));
      await writeFile(join(target, `${record.pixel_hash}.json`), messages, { flag: "wx" });
      await writeFile(join(target, `${record.pixel_hash}.bin`), pixels, { flag: "wx" });
      records.set(record.pixel_hash, { ...record, messages_sha256: sha(messages) });
    }
    assert.equal(new Set(capture.references).size, capture.references.length);
    for (const hash of capture.references)
      assert(records.has(hash), "Frame refers to uncaptured raster");
    this.#cases.set(caseId, records);
    return capture.references;
  }
  records(caseId) {
    return [...(this.#cases.get(caseId)?.values() ?? [])];
  }
}
