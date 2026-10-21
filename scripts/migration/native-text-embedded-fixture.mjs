import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Equivalent physical faces and an unembedded alias expose accidental platform substitution. */
export async function prepareEmbeddedTextFixture(context) {
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const corpusBytes = await readFile(join(context.root, "tests/parity/corpus.json"));
  const assignment = JSON.parse(corpusBytes).cases.find((c) => c.id === "scene-motion-blur");
  const bytes = await readFile(join(context.root, assignment.project)),
    original = JSON.parse(bytes);
  const fontPath = join(context.env.SystemRoot ?? "C:/Windows", "Fonts/segoeuib.ttf");
  assert((await stat(fontPath)).size <= 4 * 1024 * 1024);
  const font = await readFile(fontPath);
  const unqualifiedPath = join(context.env.SystemRoot ?? "C:/Windows", "Fonts/georgiab.ttf");
  assert((await stat(unqualifiedPath)).size <= 4 * 1024 * 1024);
  const unqualified = await readFile(unqualifiedPath);
  assert(!original.fonts?.length);
  const manifest = {
    scope: "native-embedded-equivalent-face-v1",
    font: { path: fontPath, sha256: sha256(font) },
    unqualified_font: { path: unqualifiedPath, sha256: sha256(unqualified) },
    template: { ...assignment, project_sha256: sha256(bytes), corpus_sha256: sha256(corpusBytes) },
    cases: [{ ...assignment, project_sha256: sha256(bytes) }],
  };
  for (const mode of ["native", "system", "unqualified"]) {
    const embedded = mode !== "system";
    const project = structuredClone(original),
      layers = project.compositions.flatMap((c) => c.layers).filter((l) => l.kind === "text");
    assert.equal(layers.length, 1);
    assert.equal(layers[0].textStyle.fontFamily, "Segoe UI, sans-serif");
    assert.equal(layers[0].textStyle.fontWeight, 700);
    layers[0].textStyle.fontFamily = "Arial";
    project.fonts = embedded
      ? [
          {
            id: mode === "native" ? "embedded-native-outline" : "embedded-unqualified-control",
            name: mode === "native" ? "Embedded Segoe UI Bold" : "Embedded Georgia Bold",
            family: "Arial",
            weight: 700,
            dataUrl: `data:font/ttf;base64,${(mode === "native" ? font : unqualified).toString("base64")}`,
          },
        ]
      : [];
    const id =
        mode === "native"
          ? "embedded-native-outline"
          : mode === "system"
            ? "embedded-system-control"
            : "embedded-unqualified-control",
      directory = join(context.output, id),
      path = join(directory, "project.json");
    await mkdir(directory, { recursive: true });
    const raw = `${JSON.stringify(project, null, 2)}\n`;
    await writeFile(path, raw, { flag: "wx" });
    manifest.cases.push({
      ...assignment,
      id,
      project: local(path),
      project_sha256: sha256(raw),
      project_fonts_sha256: sha256(JSON.stringify(project.fonts)),
    });
  }
  const path = join(context.output, "manifest.json");
  await writeAtomicJson(path, manifest);
  return { path, manifest };
}

/** Prove that only font delivery changes, while independent TS layout and pixels remain identical. */
export async function auditEmbeddedTextFixture(
  reader,
  context,
  manifestPath,
  observationRoot,
  observations,
  reference,
) {
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const manifest = await reader.json(local(manifestPath));
  assert.equal(manifest.scope, "native-embedded-equivalent-face-v1");
  assert.equal(manifest.template.project_sha256, reference.inputs.project_sha256);
  const { project_sha256: originalSha, corpus_sha256, ...assignment } = manifest.template;
  assert.deepEqual(assignment, reference.inputs.case);
  await reader.json("tests/parity/corpus.json", corpus_sha256);
  const original = await reader.json(assignment.project, originalSha);
  const embedded = manifest.cases.find((c) => c.id === "embedded-native-outline"),
    system = manifest.cases.find((c) => c.id === "embedded-system-control");
  const project = await reader.json(embedded.project, embedded.project_sha256),
    control = await reader.json(system.project, system.project_sha256);
  assert.equal(project.fonts.length, 1);
  const font = project.fonts[0];
  assert.deepEqual(
    { ...font, dataUrl: null },
    {
      id: "embedded-native-outline",
      name: "Embedded Segoe UI Bold",
      family: "Arial",
      weight: 700,
      dataUrl: null,
    },
  );
  assert(font.dataUrl.startsWith("data:font/ttf;base64,"));
  assert.equal(sha256(Buffer.from(font.dataUrl.split(",")[1], "base64")), manifest.font.sha256);
  const restored = structuredClone(project),
    layers = restored.compositions.flatMap((c) => c.layers).filter((l) => l.kind === "text");
  assert.equal(layers.length, 1);
  assert.equal(layers[0].textStyle.fontFamily, "Arial");
  layers[0].textStyle.fontFamily = "Segoe UI, sans-serif";
  if (original.fonts === undefined) delete restored.fonts;
  else restored.fonts = original.fonts;
  assert.deepEqual(restored, original);
  assert.deepEqual(control, { ...project, fonts: [] });
  const sources = [assignment.id, embedded.id, system.id].map((id) =>
    observations.cases.find((c) => c.id === id),
  );
  assert(sources.every(Boolean));
  assert.equal(sources[0].project_sha256, originalSha);
  assert.equal(sources[1].project_sha256, embedded.project_sha256);
  assert.equal(sources[2].project_sha256, system.project_sha256);
  for (const [i, item] of [embedded, system].entries()) {
    assert.equal(sources[i + 1].project_fonts_sha256, item.project_fonts_sha256);
    assert.deepEqual(sources[i + 1].samples, sources[0].samples);
    assert.equal(sources[i + 1].observations.length, sources[0].observations.length);
  }
  const normalized = (record) => {
    const r = structuredClone(record);
    delete r.project_fonts_sha256;
    delete r.retained_reference.source;
    r.layout_font = null;
    for (const d of [...r.draws, ...r.measures]) d.font = null;
    return r;
  };
  let differences = 0;
  for (const [index, sample] of sources[0].samples.entries()) {
    const rows = [];
    for (const source of sources) {
      const entry = source.observations[index];
      const row = await reader.json(
        local(join(observationRoot, "ordinary", source.id, entry.path)),
        entry.sha256,
      );
      assert.deepEqual(row.sample, sample);
      assert.equal(row.records.length, 1);
      rows.push(row.records[0]);
    }
    assert.deepEqual(
      normalized(rows[1]),
      normalized(rows[0]),
      "Embedded face changed TS geometry or pixels",
    );
    assert.equal(rows[1].project_fonts_sha256, embedded.project_fonts_sha256);
    differences += Number(rows[2].rgba_sha256 !== rows[1].rgba_sha256);
  }
  assert.equal(
    differences,
    sources[0].samples.length,
    "System substitution control must differ at every sample",
  );
  return {
    assignment: embedded,
    project,
    source: sources[1],
    font: manifest.font,
    exact_samples: sources[0].samples.length,
    system_substitution_differences: differences,
  };
}
