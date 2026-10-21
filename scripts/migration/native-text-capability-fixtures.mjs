import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Authored font/script cases preserve real provider behavior and physical face identity. */
export async function prepareTextCapabilityFixtures(context) {
  assert.equal(process.platform, "win32");
  const local = (p) => relative(context.root, p).replaceAll("\\", "/"),
    fonts = {};
  for (const name of ["arial", "georgia", "tahoma"]) {
    const path = join(context.env.SystemRoot ?? "C:/Windows", `Fonts/${name}.ttf`);
    assert((await stat(path)).size <= 4 * 1024 * 1024);
    const bytes = await readFile(path);
    fonts[name] = { path, bytes, sha256: sha256(bytes) };
  }
  const corpus = await readFile(join(context.root, "tests/parity/corpus.json")),
    template = JSON.parse(corpus).cases.find((c) => c.id === "scene-motion-blur"),
    originalBytes = await readFile(join(context.root, template.project)),
    original = JSON.parse(originalBytes);
  assert.equal(original.sources.length, 0);
  const bidi =
      "text requires retained rendering: bidirectional paragraph requires independently verified visual runs",
    cases = [
      {
        id: "font-unavailable",
        family: "Agency FB",
        layers: [{ text: "Aster 123", reason: "requested font families unavailable: Agency FB" }],
      },
      {
        id: "font-missing-glyph",
        family: "Georgia",
        font: "georgia",
        layers: [
          { text: "THEME Ⅱ", reason: "no admitted fallback font covers UTF-16 interval 6..7" },
          {
            text: "THEME II",
            reason: "requested primary family and CSS family syntax require raster qualification",
          },
          {
            text: "A\r\nTHEME Ⅱ",
            reason: "no admitted fallback font covers UTF-16 interval 9..10",
          },
          {
            text: "THEME Ⅱ",
            family: "Georgia, Tahoma",
            fonts: [
              ["georgia", "Georgia"],
              ["tahoma", "Tahoma"],
            ],
            reason: "script raster coverage requires isolated pixel qualification",
          },
        ],
      },
      {
        id: "font-mixed-bidi",
        family: "Arial",
        font: "arial",
        layers: [{ text: "ABC אבג 123", reason: bidi }],
      },
      {
        id: "font-embedded-bidi",
        family: "Segoe UI",
        font: "arial",
        embedded: true,
        layers: [{ text: "ABC אבג 123", reason: bidi }],
      },
    ];
  const manifest = {
    scope: "production-font-script-capabilities-v1",
    sources: Object.fromEntries(
      Object.entries(fonts).map(([name, { path, sha256 }]) => [name, { path, sha256 }]),
    ),
    template: {
      path: template.project,
      sha256: sha256(originalBytes),
      corpus_sha256: sha256(corpus),
    },
    cases: [],
  };
  for (const item of cases) {
    const project = structuredClone(original),
      composition = project.compositions.find((c) => c.id === template.composition),
      text = composition.layers.filter((l) => l.kind === "text");
    assert.equal(text.length, 1);
    const base = text[0];
    composition.layers = composition.layers.filter((l) => l.kind !== "text");
    const expected = [];
    for (const [index, spec] of item.layers.entries()) {
      const layer = structuredClone(base);
      layer.id = `${base.id}-coverage-${index}`;
      layer.text = spec.text;
      layer.textStyle = {
        ...layer.textStyle,
        fontFamily: spec.family ?? item.family,
        fontWeight: 400,
        fontSize: 32,
        strokeWidth: 0,
      };
      delete layer.textAnimator;
      composition.layers.push(layer);
      expected.push({
        layer: layer.id,
        text: spec.text,
        reason: spec.reason,
        fonts: (spec.fonts ?? (item.font ? [[item.font, item.family]] : [])).map(
          ([name, family]) => ({ family, sha256: fonts[name].sha256 }),
        ),
      });
    }
    project.fonts = item.embedded
      ? [
          {
            id: "migration-script-face",
            name: "Embedded Arial",
            family: item.family,
            weight: 400,
            dataUrl: `data:font/ttf;base64,${fonts.arial.bytes.toString("base64")}`,
          },
        ]
      : [];
    const path = join(context.output, item.id, "project.json");
    await mkdir(join(context.output, item.id), { recursive: true });
    const raw = `${JSON.stringify(project, null, 2)}\n`;
    await writeFile(path, raw, { flag: "wx" });
    manifest.cases.push({
      ...template,
      id: item.id,
      project: local(path),
      project_sha256: sha256(raw),
      project_fonts_sha256: sha256(JSON.stringify(project.fonts)),
      frames: [0, 15],
      expected,
    });
  }
  const path = join(context.output, "manifest.json");
  await writeAtomicJson(path, manifest);
  return { path, manifest };
}
