import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Wrap a local SFNT without changing its tables; never redistribute installed font bytes. */
export function fontContainers(font) {
  assert(font.length >= 12 && font.length <= 4 * 1024 * 1024);
  assert.equal(font.readUInt32BE(0), 0x10000);
  const count = font.readUInt16BE(4);
  assert(count > 0 && count < 256 && 12 + count * 16 <= font.length);
  const tables = [];
  for (let i = 0; i < count; i++) {
    const offset = 12 + i * 16,
      tag = font.toString("ascii", offset, offset + 4),
      start = font.readUInt32BE(offset + 8),
      length = font.readUInt32BE(offset + 12);
    assert(start >= 12 + count * 16 && start + length <= font.length);
    if (tag === "DSIG") continue;
    let value = length;
    const encoded = [value & 127];
    while (value >= 128) {
      value = Math.floor(value / 128);
      encoded.unshift((value & 127) | 128);
    }
    tables.push({ tag, length, data: font.subarray(start, start + length), encoded });
  }
  assert.equal(new Set(tables.map((t) => t.tag)).size, tables.length);
  const directory = Buffer.concat(
    tables.flatMap((t) => [
      Buffer.from([63 | (t.tag === "glyf" || t.tag === "loca" ? 192 : 0)]),
      Buffer.from(t.tag, "ascii"),
      Buffer.from(t.encoded),
    ]),
  );
  const compressed = brotliCompressSync(Buffer.concat(tables.map((t) => t.data)), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 5,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
    },
  });
  const woff2 = Buffer.alloc(Math.ceil((48 + directory.length + compressed.length) / 4) * 4);
  woff2.write("wOF2");
  woff2.writeUInt32BE(0x10000, 4);
  woff2.writeUInt32BE(woff2.length, 8);
  woff2.writeUInt16BE(tables.length, 12);
  woff2.writeUInt32BE(
    12 + tables.length * 16 + tables.reduce((n, t) => n + Math.ceil(t.length / 4) * 4, 0),
    16,
  );
  woff2.writeUInt32BE(compressed.length, 20);
  woff2.writeUInt16BE(1, 24);
  directory.copy(woff2, 48);
  compressed.copy(woff2, 48 + directory.length);
  const collection = Buffer.alloc(16 + font.length);
  collection.write("ttcf");
  collection.writeUInt32BE(0x10000, 4);
  collection.writeUInt32BE(1, 8);
  collection.writeUInt32BE(16, 12);
  font.copy(collection, 16);
  for (let i = 0; i < count; i++) {
    const offset = 16 + 12 + i * 16 + 8;
    collection.writeUInt32BE(collection.readUInt32BE(offset) + 16, offset);
  }
  return {
    ttf: font,
    woff2,
    collection,
    "invalid-woff2": Buffer.from("wOF2 opaque decoder input"),
  };
}

export async function prepareTextFontFixtures(context) {
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  assert.equal(process.platform, "win32", "Embedded font fixture needs the qualified Windows host");
  const fontPath = join(context.env.SystemRoot ?? "C:/Windows", "Fonts/arial.ttf");
  assert((await stat(fontPath)).size <= 4 * 1024 * 1024);
  const font = await readFile(fontPath),
    containers = fontContainers(font),
    corpusBytes = await readFile(join(context.root, "tests/parity/corpus.json")),
    template = JSON.parse(corpusBytes).cases.find((c) => c.id === "scene-motion-blur"),
    originalBytes = await readFile(join(context.root, template.project)),
    original = JSON.parse(originalBytes);
  assert.equal(original.sources.length, 0);
  const manifest = {
    scope: "production-text-font-capabilities-v1",
    font: { path: fontPath, sha256: sha256(font), bytes: font.length },
    template: {
      path: template.project,
      sha256: sha256(originalBytes),
      corpus_sha256: sha256(corpusBytes),
    },
    alias: "Segoe UI",
    physical_face: "Arial",
    cases: [],
  };
  for (const format of ["ttf", "woff2", "collection", "system", "invalid-woff2"]) {
    const project = structuredClone(original),
      layers = project.compositions.flatMap((c) => c.layers).filter((l) => l.kind === "text");
    assert.equal(layers.length, 1);
    const layer = layers[0];
    layer.text = "Aster 123";
    layer.textStyle = {
      ...layer.textStyle,
      fontFamily: manifest.alias,
      fontWeight: 400,
      fontSize: 32,
      strokeWidth: 0,
    };
    delete layer.textAnimator;
    const bytes = containers[format];
    project.fonts = bytes
      ? [
          {
            id: "migration-embedded-face",
            name: `Embedded ${format}`,
            family: manifest.alias,
            weight: 400,
            dataUrl: `data:font/${format.includes("woff2") ? "woff2" : "ttf"};base64,${bytes.toString("base64")}`,
          },
        ]
      : [];
    const id = `font-${format}`,
      directory = join(context.output, id),
      path = join(directory, "project.json");
    await mkdir(directory, { recursive: true });
    const raw = `${JSON.stringify(project, null, 2)}\n`;
    await writeFile(path, raw, { flag: "wx" });
    manifest.cases.push({
      ...template,
      id,
      project: local(path),
      frames: [0, 15],
      format,
      layer: layer.id,
      project_sha256: sha256(raw),
      font_sha256: bytes ? sha256(bytes) : null,
      project_fonts_sha256: sha256(JSON.stringify(project.fonts)),
      expected_reason:
        format === "woff2"
          ? "embedded font migration-embedded-face: Woff2DecoderUnavailable"
          : format === "collection"
            ? "embedded font migration-embedded-face: EmbeddedCollectionSelectionUnverified"
            : null,
    });
  }
  const path = join(context.output, "manifest.json");
  await writeAtomicJson(path, manifest);
  return { path, manifest };
}
