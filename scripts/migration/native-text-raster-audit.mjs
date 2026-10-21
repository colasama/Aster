import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeRgbaPng } from "../parity/png.mjs";
import { sha256 } from "./m0-evidence.mjs";

/** Reconstruct every atlas cell from authenticated glyph images, including zero padding. */
export async function auditNativeTextRasters(root, report, requests, results) {
  assert(report && report.native_pixel_acceptance === false);
  assert(report.queries.length > 0 && report.queries.length <= 100_000);
  const glyphs = new Map(),
    seenFiles = new Set();
  const load = async (record, width, height, format) => {
    assert.match(record.path, /^glyph-rasters\/(?:glyph-[a-f0-9]{64}|page-\d+)\.png$/);
    assert(!seenFiles.has(record.path));
    seenFiles.add(record.path);
    const bytes = await readFile(join(root, record.path));
    assert.equal(sha256(bytes), record.sha256);
    const image = decodeRgbaPng(bytes);
    assert.equal(image.width, width);
    assert.equal(image.height, height);
    assert(["coverage", "premultiplied_srgb_rgba"].includes(format));
    let raw = image.pixels;
    if (format === "coverage") {
      raw = Buffer.alloc(width * height);
      for (let i = 0; i < raw.length; i++) {
        assert(
          image.pixels[i * 4] === 255 &&
            image.pixels[i * 4 + 1] === 255 &&
            image.pixels[i * 4 + 2] === 255,
        );
        raw[i] = image.pixels[i * 4 + 3];
      }
    } else {
      for (let i = 0; i < raw.length; i += 4)
        assert(raw[i] <= raw[i + 3] && raw[i + 1] <= raw[i + 3] && raw[i + 2] <= raw[i + 3]);
    }
    assert.equal(sha256(raw), record.raw_sha256);
    return raw;
  };
  assert(Object.keys(report.glyphs).length > 0 && Object.keys(report.glyphs).length <= 16_384);
  for (const [id, glyph] of Object.entries(report.glyphs)) {
    assert.equal(id, sha256(Buffer.from(JSON.stringify(glyph.key))));
    assert(Number.isFinite(glyph.nominal_advance));
    assert(glyph.origin.length === 2 && glyph.origin.every(Number.isInteger));
    assert(Number.isInteger(glyph.width) && Number.isInteger(glyph.height));
    assert(glyph.width >= 0 && glyph.width <= 4096 && glyph.height >= 0 && glyph.height <= 4096);
    assert.equal(glyph.width === 0, glyph.height === 0);
    if (glyph.width === 0) assert.equal(glyph.image, null);
    const data =
      glyph.width === 0
        ? Buffer.alloc(0)
        : await load(glyph.image, glyph.width, glyph.height, glyph.format);
    glyphs.set(id, { ...glyph, data });
  }
  const expected = new Map();
  const inputs = new Map(requests.map((q) => [q.id, q]));
  for (const result of results) {
    if (result.error) continue;
    const input = inputs.get(result.id);
    assert(input);
    const add = (id, shaped, size) => {
      for (const mode of ["fill", "stroke", "hinted"])
        expected.set(`${id}/${mode}`, { shaped, size, mode });
    };
    if (result.shaped) add(result.id, result.shaped, input.query.size);
    else
      for (const [line, row] of result.layout.lines.entries())
        for (const [fragment, run] of row.fragments.entries())
          add(`${result.id}:${line}:${fragment}`, run.shaped, input.query.request.font_size);
  }
  const seenQueries = new Set(),
    usedGlyphs = new Set(),
    unsupported = [];
  let completed = 0;
  const bits = (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return b.readUInt32LE();
  };
  for (const query of report.queries) {
    const id = `${query.id}/${query.mode}`,
      target = expected.get(id);
    assert(target && !seenQueries.has(id));
    seenQueries.add(id);
    assert(query.glyphs.length <= target.shaped.glyphs.length);
    if (query.error) {
      assert.match(query.error, /^glyph raster requires retained rendering: /);
      unsupported.push({ id, reason: query.error });
    } else {
      assert.equal(query.glyphs.length, target.shaped.glyphs.length);
      completed++;
    }
    let cursor = 0;
    for (const [index, glyphId] of query.glyphs.entries()) {
      const image = glyphs.get(glyphId),
        source = target.shaped.glyphs[index];
      assert(image);
      usedGlyphs.add(glyphId);
      assert.deepEqual(image.key.face, source.face);
      assert.deepEqual(
        image.key.variations,
        source.variations.map(([tag, value]) => [tag, bits(value)]),
      );
      assert.equal(image.key.glyph_id, source.glyph_id);
      assert.equal(image.key.size_bits, bits(target.size));
      const phase = (v) => {
        const f = Math.fround(v),
          r = f % 1,
          p = r < 0 ? Math.fround(r + 1) : r;
        return bits(p === 0 ? 0 : p);
      };
      assert.deepEqual(image.key.phase_bits, [
        phase(cursor + source.offset[0]),
        phase(source.offset[1] + target.shaped.middle_baseline_offset),
      ]);
      assert.equal(image.key.hinting, query.mode === "hinted" ? "vertical" : "none");
      assert.equal(image.key.stroke_bits, query.mode === "stroke" ? bits(2) : null);
      assert.deepEqual(image.key.foreground, [255, 255, 255, 255]);
      assert.equal(image.key.prefer_bitmap, true);
      cursor += source.advance[0];
    }
  }
  assert.equal(seenQueries.size, expected.size);
  assert.equal(usedGlyphs.size, glyphs.size);
  assert(completed > 0);
  assert(report.pages.length <= 16);
  const pages = [];
  for (const page of report.pages) {
    assert.equal(page.dimension, 1024);
    const channels = page.format === "coverage" ? 1 : 4;
    assert.equal(page.bytes_per_row, page.dimension * channels);
    pages.push({
      ...page,
      channels,
      data: await load(page.image, page.dimension, page.dimension, page.format),
      expected: Buffer.alloc(page.dimension * page.dimension * channels),
      occupied: new Uint8Array(page.dimension * page.dimension),
    });
  }
  const seenPlacements = new Set();
  const generation = createHash("sha256");
  generation.update("aster.glyph-atlas.v1");
  const dimension = Buffer.alloc(4);
  dimension.writeUInt32LE(1024);
  generation.update(dimension);
  for (const placement of report.placements) {
    const id = sha256(Buffer.from(JSON.stringify(placement.key))),
      glyph = glyphs.get(id);
    assert(glyph && !seenPlacements.has(id));
    seenPlacements.add(id);
    assert.deepEqual(placement.origin, glyph.origin);
    assert.equal(placement.nominal_advance, glyph.nominal_advance);
    assert.equal(placement.rect.length, 4);
    assert(placement.rect.every(Number.isInteger));
    const [x, y, width, height] = placement.rect;
    assert.equal(width, glyph.width);
    assert.equal(height, glyph.height);
    const metadata = Buffer.from(
      JSON.stringify([
        glyph.key,
        glyph.format,
        width,
        height,
        glyph.origin,
        bits(glyph.nominal_advance),
      ]),
    );
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(metadata.length));
    generation.update(length);
    generation.update(metadata);
    generation.update(createHash("sha256").update(glyph.data).digest());
    if (width === 0) {
      assert.equal(placement.page, null);
      continue;
    }
    const page = pages[placement.page];
    assert(page && page.format === glyph.format);
    assert(x >= 1 && y >= 1 && x + width < page.dimension && y + height < page.dimension);
    for (let row = y - 1; row <= y + height; row++)
      for (let col = x - 1; col <= x + width; col++) {
        const offset = row * page.dimension + col;
        assert.equal(page.occupied[offset], 0);
        page.occupied[offset] = 1;
      }
    for (let row = 0; row < height; row++)
      glyph.data.copy(
        page.expected,
        (y + row) * page.bytes_per_row + x * page.channels,
        row * width * page.channels,
        (row + 1) * width * page.channels,
      );
  }
  assert.equal(seenPlacements.size, glyphs.size);
  assert.equal(generation.digest("hex"), report.generation);
  for (const page of pages)
    assert(page.data.equals(page.expected), "Atlas pixels or padding differ from glyph images");
  return {
    status: "passed",
    glyphs: glyphs.size,
    queries: seenQueries.size,
    completed_queries: completed,
    unsupported,
    pages: pages.length,
    native_pixel_acceptance: false,
  };
}
