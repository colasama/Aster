import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { encodeRgbaPng } from "../parity/png.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { auditNativeTextRasters } from "./native-text-raster-audit.mjs";

test("raster evidence rejects missing queries, overlapping placements and changed atlas bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-glyph-audit-"));
  try {
    await mkdir(join(root, "glyph-rasters"));
    const bits = (v) => {
      const bytes = Buffer.alloc(4);
      bytes.writeFloatLE(v);
      return bytes.readUInt32LE();
    };
    const publish = async (path, width, height, data) => {
      const pixels = Buffer.alloc(data.length * 4, 255);
      for (let index = 0; index < data.length; index++) pixels[index * 4 + 3] = data[index];
      const png = encodeRgbaPng(width, height, pixels);
      await writeFile(join(root, path), png);
      return { path, sha256: sha256(png), raw_sha256: sha256(data) };
    };
    const face = { sha256: new Array(32).fill(1), index: 0 };
    const report = {
      glyphs: {},
      queries: [],
      placements: [],
      pages: [],
      native_pixel_acceptance: false,
    };
    const page = Buffer.alloc(1024 * 1024),
      data = Buffer.from([255, 128, 0, 255]);
    const generation = createHash("sha256");
    generation.update("aster.glyph-atlas.v1");
    const dimension = Buffer.alloc(4);
    dimension.writeUInt32LE(1024);
    generation.update(dimension);
    for (const [index, mode] of ["fill", "stroke", "hinted"].entries()) {
      const key = {
        face,
        variations: [],
        glyph_id: 1,
        size_bits: bits(20),
        phase_bits: [0, 0],
        hinting: mode === "hinted" ? "vertical" : "none",
        stroke_bits: mode === "stroke" ? bits(2) : null,
        foreground: [255, 255, 255, 255],
        prefer_bitmap: true,
      };
      const id = sha256(Buffer.from(JSON.stringify(key)));
      const glyph = {
        key,
        format: "coverage",
        width: 2,
        height: 2,
        origin: [0, -2],
        nominal_advance: 2,
        image: await publish(`glyph-rasters/glyph-${id}.png`, 2, 2, data),
      };
      report.glyphs[id] = glyph;
      report.queries.push({ id: "request", mode, glyphs: [id], error: null });
      const x = index * 4 + 1;
      report.placements.push({
        key,
        page: 0,
        rect: [x, 1, 2, 2],
        origin: glyph.origin,
        nominal_advance: 2,
      });
      data.copy(page, 1024 + x, 0, 2);
      data.copy(page, 2048 + x, 2, 4);
      const metadata = Buffer.from(JSON.stringify([key, "coverage", 2, 2, glyph.origin, bits(2)]));
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(metadata.length));
      generation.update(length);
      generation.update(metadata);
      generation.update(createHash("sha256").update(data).digest());
    }
    report.generation = generation.digest("hex");
    report.pages.push({
      format: "coverage",
      dimension: 1024,
      bytes_per_row: 1024,
      image: await publish("glyph-rasters/page-0.png", 1024, 1024, page),
    });
    const requests = [{ id: "request", query: { size: 20 } }];
    const results = [
      {
        id: "request",
        shaped: {
          glyphs: [{ face, variations: [], glyph_id: 1, offset: [0, 0], advance: [2, 0] }],
          middle_baseline_offset: 0,
        },
      },
    ];
    assert.equal((await auditNativeTextRasters(root, report, requests, results)).status, "passed");
    const missing = structuredClone(report);
    missing.queries.pop();
    await assert.rejects(auditNativeTextRasters(root, missing, requests, results));
    const overlap = structuredClone(report);
    overlap.placements[1].rect[0] = 1;
    await assert.rejects(auditNativeTextRasters(root, overlap, requests, results));
    const wrongFace = structuredClone(report);
    Object.values(wrongFace.glyphs)[0].key.face.index = 1;
    await assert.rejects(auditNativeTextRasters(root, wrongFace, requests, results));
    page[0] = 255;
    report.pages[0].image = await publish("glyph-rasters/page-0.png", 1024, 1024, page);
    await assert.rejects(
      auditNativeTextRasters(root, report, requests, results),
      /Atlas pixels or padding/,
    );
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith("aster-glyph-audit-"));
    await rm(root, { recursive: true, force: true });
  }
});
