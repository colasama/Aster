import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** The real rasterizer must agree with allocation-free production capability probes. */
export async function auditTextPaintCapabilities(context, manifest, binary, execute) {
  const report = { status: "failed", queries: [] },
    reader = new M0Evidence(context.root),
    local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    const inputs = [],
      expected = [];
    for (const item of manifest.cases)
      for (const [index, spec] of item.expected.entries()) {
        if (!spec.paint) continue;
        const project = await reader.json(item.project, item.project_sha256),
          layer = project.compositions
            .find((c) => c.id === item.composition)
            .layers.find((l) => l.id === spec.layer);
        assert.equal(layer.text, spec.text);
        assert.equal(layer.textStyle.fontSize, spec.paint.size);
        assert.equal(layer.textStyle.strokeWidth, spec.paint.stroke);
        const id = `${item.id}-${index}`;
        inputs.push({
          id,
          font: {
            families: [layer.textStyle.fontFamily],
            weight: layer.textStyle.fontWeight,
            italic: false,
          },
          query: {
            kind: "shape",
            text: spec.text,
            size: spec.paint.size,
            direction: "left_to_right",
            language: "zh-CN",
          },
        });
        expected.push({ ...spec, id });
      }
    assert.equal(inputs.length, 4);
    const input = join(context.output, "requests.json"),
      output = join(context.output, "native.json");
    await writeAtomicJson(input, inputs);
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    report.input = { path: local(input), sha256: await hashFile(input) };
    report.step = await execute(
      {
        id: "native-glyph-paint-controls",
        file: binary,
        args: [
          "text-layout",
          "--input",
          input,
          "--out",
          output,
          "--max-catalog-bytes",
          "1073741824",
          "--rasterize",
        ],
      },
      context,
    );
    assert.equal(report.step.status, "passed");
    const native = await reader.json(local(output));
    report.output = { path: local(output), sha256: await hashFile(output) };
    assert.equal(native.input_sha256, report.input.sha256);
    assert.equal(native.results.length, expected.length);
    assert.equal(native.native_raster, false);
    assert.equal(native.raster_components.native_pixel_acceptance, false);
    assert.equal(native.raster_components.queries.length, expected.length * 3);
    for (const spec of expected) {
      const shaped = native.results.find((r) => r.id === spec.id);
      assert.equal(shaped.error, null);
      assert.equal(shaped.shaped.glyphs.length, 1);
      const glyph = shaped.shaped.glyphs[0];
      assert.equal(glyph.glyph_id, spec.paint.glyph);
      assert.equal(glyph.face.index, 0);
      assert.equal(Buffer.from(glyph.face.sha256).toString("hex"), spec.fonts[0].sha256);
      const query = native.raster_components.queries.find(
        (q) => q.id === spec.id && q.mode === (spec.paint.stroke > 0 ? "stroke" : "fill"),
      );
      assert.equal(
        query.error,
        spec.paint.limitation
          ? `glyph raster requires retained rendering: ${spec.paint.limitation}`
          : null,
      );
      if (spec.paint.limitation) assert.equal(query.glyphs.length, 0);
      else {
        assert.equal(query.glyphs.length, 1);
        const raster = native.raster_components.glyphs[query.glyphs[0]];
        assert(raster && raster.width > 0 && raster.height > 0);
        assert.deepEqual(raster.key.face, glyph.face);
        assert.equal(raster.key.glyph_id, glyph.glyph_id);
        const image = await reader.image(
          local(join(context.output, raster.image.path)),
          raster.image.sha256,
        );
        assert.equal(image.width, raster.width);
        assert.equal(image.height, raster.height);
      }
      report.queries.push({
        id: spec.id,
        face: glyph.face,
        glyph: glyph.glyph_id,
        paint: spec.paint,
        error: query.error,
      });
    }
    assert.equal(await hashFile(binary), report.binary.sha256);
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
