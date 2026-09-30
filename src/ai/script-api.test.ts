import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { activeComposition, createBlankProject } from "../core/project/project";
import { executeScript } from "./script-runtime";

function task(code: string, modules?: Record<string, string>) {
  return { code, project: createBlankProject(), currentTime: 0, maxOperations: 4096, modules };
}

function videoTask(code: string) {
  const input = task(code);
  const composition = activeComposition(input.project);
  input.project.sources = [
    {
      id: "clip",
      kind: "video",
      name: "Clip.mp4",
      mimeType: "video/mp4",
      contentIdentity: "sha256:clip",
      runtimeUrl: "asset://clip.mp4",
      width: 64,
      height: 36,
      duration: 7,
      interpretation: { alpha: "ignore", colorSpace: "srgb" },
    },
  ];
  const layer = createLayerForComposition("video", composition);
  layer.id = "video-layer";
  layer.sourceId = "clip";
  layer.inPoint = 57;
  layer.outPoint = 61;
  composition.duration = 120;
  composition.layers.push(layer);
  return input;
}

describe("agent script API", () => {
  it("reports script errors with line numbers relative to the submitted code", async () => {
    await expect(
      executeScript(task("const a = 1;\nconst b = 2;\nundefinedHelper();")),
    ).rejects.toMatchObject({
      code: "script_failed",
      message: expect.stringContaining("line 3"),
      details: { line: 3 },
    });
    await expect(
      executeScript(
        task(
          "const c = aster.compositions.active();\naster.command({type:'removeLayer',layerId:'missing'});",
        ),
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Layer does not exist: missing.*active composition.*line 2/su),
      details: { line: 2, commandType: "removeLayer" },
    });
  });

  it("returns created IDs, finds objects by name and selects inspected fields", async () => {
    const result = await executeScript(
      task(`
        const c = aster.compositions.active();
        const a = c.layers.addText({ name: 'Title', text: 'Hi', color: '#ff0000' });
        const b = c.layers.addText({ name: 'Sub', text: 'There' });
        const nested = c.precompose([a.id, b.id], 'SHOT_01');
        return {
          nested: { compositionId: nested.compositionId, wrapperLayerId: nested.wrapperLayerId },
          found: aster.compositions.find('SHOT_01').id,
          missing: aster.compositions.find('SHOT_99') === undefined,
          prefixed: aster.compositions.list({ namePrefix: 'SHOT_' }).map(item => item.name),
          title: nested.composition.layers.find('Title').inspect(['name', 'color', 'transform.opacity.mode']),
          budget: aster.budget().operations,
          color: aster.color('#00ff0080'),
        };
      `),
    );
    const data = result.result as {
      nested: { compositionId: string; wrapperLayerId: string };
      found: string;
      missing: boolean;
      prefixed: string[];
      title: Record<string, unknown>;
      budget: { used: number; remaining: number };
      color: number[];
    };
    const nested = result.project.compositions.find((c) => c.id === data.nested.compositionId);
    expect(nested?.name).toBe("SHOT_01");
    expect(
      activeComposition(result.project).layers.some((l) => l.id === data.nested.wrapperLayerId),
    ).toBe(true);
    expect(data.found).toBe(data.nested.compositionId);
    expect(data.missing).toBe(true);
    expect(data.prefixed).toEqual(["SHOT_01"]);
    expect(data.title).toEqual({
      name: "Title",
      color: [1, 0, 0, 1],
      "transform.opacity.mode": "static",
    });
    expect(data.budget.used).toBe(result.operations.length);
    expect(data.budget.remaining).toBe(4096 - result.operations.length);
    expect(data.color).toEqual([0, 1, 0, 128 / 255]);
  });

  it("converts hex colors to display values for text and linear light for shapes and solids", async () => {
    const result = await executeScript(
      task(`
        const c = aster.compositions.active();
        const text = c.layers.addText({ text: 'x', color: '#808080' });
        const solid = c.layers.add({ kind: 'solid', color: '#808080' });
        return {
          text: text.inspect(['color']).color,
          solid: solid.inspect(['color']).color,
          linear: aster.linearColor('#ffffff', 0.5),
        };
      `),
    );
    const data = result.result as { text: number[]; solid: number[]; linear: number[] };
    expect(data.text[0]).toBeCloseTo(128 / 255, 6);
    expect(data.solid[0]).toBeCloseTo(0.2158605, 6);
    expect(data.linear).toEqual([1, 1, 1, 0.5]);
  });

  it("loads session modules once per execution and reports missing modules", async () => {
    const modules = {
      lib: "globalThis.loads = (globalThis.loads || 0) + 1;\nmodule.exports = { double: x => x * 2 };",
      value: "return { answer: aster.compositions.active().id.length > 0 };",
    };
    const result = await executeScript(
      task(
        "const a = aster.require('lib'); const b = aster.require('lib'); return [a.double(21), a === b, globalThis.loads, aster.require('value').answer];",
        modules,
      ),
    );
    expect(result.result).toEqual([42, true, 1, true]);
    await expect(
      executeScript(task("return aster.require('absent');", modules)),
    ).rejects.toMatchObject({
      code: "module_not_found",
      message: expect.stringContaining("lib, value"),
    });
    await expect(
      executeScript(task("return aster.require('broken');", { broken: "const x = 1;\nnull.y;" })),
    ).rejects.toMatchObject({ message: expect.stringContaining("module broken line 2") });
  });

  it("configures per-character text animator groups on a single layer", async () => {
    const result = await executeScript(
      task(`
        const layer = aster.compositions.active().layers.addText({ text: '黑夜BASS与心跳' });
        layer.setTextAnimator({ groups: [{
          selectors: [{ kind: 'expression', expression: '100 * (1 - clamp((time - (textIndex - 1) * 0.06) / 0.4, 0, 1))' }],
          properties: { position: [0, 40, 0], opacity: 0, blur: [8, 8] },
        }, {
          selectors: [{ start: 0, end: { mode: 'animated', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] } }],
          properties: { scale: [120, 120, 100] },
        }] });
        return layer.id;
      `),
    );
    const layer = activeComposition(result.project).layers.find((l) => l.id === result.result);
    expect(layer?.textAnimator?.enabled).toBe(true);
    const [reveal, grow] = layer?.textAnimator?.groups ?? [];
    expect(reveal.selectors[0]).toMatchObject({ kind: "expression", enabled: true });
    expect(reveal.properties.position?.[1]).toEqual({ mode: "static", value: 40 });
    expect(reveal.properties.opacity).toEqual({ mode: "static", value: 0 });
    expect(grow.selectors[0]).toMatchObject({ kind: "range", end: { mode: "animated" } });
  });

  it("warns when a video layer maps outside its source and clears the warning once fixed", async () => {
    const outside = await executeScript(
      videoTask(`
        const layer = aster.compositions.active().layers.get('video-layer');
        const reference = layer.setTimeMapping({ sourceStart: 57 });
        return { reference, range: layer.inspect(['sourceRange']).sourceRange };
      `),
    );
    expect(outside.warnings?.[0]).toContain("maps entirely outside its source (0-7s)");
    expect(outside.result).toMatchObject({
      reference: { warnings: [expect.stringContaining("sourceTime = offset")] },
      range: { start: 57, end: 61, sourceDuration: 7 },
    });
    const fixed = await executeScript(
      videoTask(`
        const layer = aster.compositions.active().layers.get('video-layer');
        layer.setTimeMapping({ sourceStart: 57 });
        layer.setTimeMapping({ sourceStart: 2 });
        return aster.warnings();
      `),
    );
    expect(fixed.result).toEqual([]);
    expect(fixed.warnings).toBeUndefined();
  });

  it("drives effect parameters with expressions and rejects invalid ones", async () => {
    const result = await executeScript(
      task(`
        const l = aster.compositions.active().layers.addText({ text: 'glow' });
        const blur = l.addEffect('gaussian-blur', { radius: 4 });
        l.setEffectExpression(blur.id, 'radius', 'value + 6 * abs(sin(time * pi * 2))');
        const glow = l.addEffect('gaussian-blur');
        l.property('effects.' + glow.id + '.radius').setExpression('time * 10');
        l.property('effects.' + glow.id + '.radius').setExpression('');
        return l.id;
      `),
    );
    const layer = activeComposition(result.project).layers.find((l) => l.id === result.result);
    expect(layer?.effects[0].parameterExpressions).toEqual({
      radius: "value + 6 * abs(sin(time * pi * 2))",
    });
    expect(layer?.effects[1].parameterExpressions).toBeUndefined();
    await expect(
      executeScript(
        task(
          "const l = aster.compositions.active().layers.addText({text:'x'}); const e = l.addEffect('gaussian-blur'); l.setEffectExpression(e.id, 'radius', 'wiggle(2)');",
        ),
      ),
    ).rejects.toThrow("Invalid expression for gaussian-blur.radius");
  });

  it("removes compositions in dependency order and collects unreachable ones", async () => {
    const result = await executeScript(
      task(`
        const main = aster.compositions.active();
        const shot = (name) => { const l = main.layers.addText({ name, text: name }); return main.precompose([l.id], name); };
        const kept = shot('SHOT_KEPT');
        const orphan = shot('SHOT_ORPHAN');
        const inner = orphan.composition.layers.list()[0];
        const nested = orphan.composition.precompose([inner.id], 'SHOT_ORPHAN_INNER');
        orphan.wrapper.remove();
        const loose = aster.compositions.add({ name: 'LOOSE', width: 64, height: 64, duration: 1 });
        const preview = aster.compositions.collectUnused({ dryRun: true });
        const removed = aster.compositions.collectUnused({ keep: ['LOOSE'] });
        const explicit = aster.compositions.remove([loose.id]);
        return { preview, removed, explicit, left: aster.compositions.list().map(c => c.name) };
      `),
    );
    const data = result.result as {
      preview: { unused: { name: string }[] };
      removed: { removed: { name: string }[] };
      explicit: { name: string }[];
      left: string[];
    };
    expect(data.preview.unused.map((c) => c.name).sort()).toEqual(
      ["LOOSE", "SHOT_ORPHAN", "SHOT_ORPHAN_INNER"].sort(),
    );
    expect(data.removed.removed.map((c) => c.name).sort()).toEqual(
      ["SHOT_ORPHAN", "SHOT_ORPHAN_INNER"].sort(),
    );
    expect(data.explicit.map((c) => c.name)).toEqual(["LOOSE"]);
    expect(data.left).toHaveLength(2);
    expect(data.left).toContain("SHOT_KEPT");
  });

  it("fits a 3D layer to the camera path and applies the multiplier", async () => {
    const result = await executeScript(
      task(`
        const c = aster.compositions.active();
        const info = c.inspect();
        const l = c.layers.add({ kind: 'solid', name: 'BG', solid: { width: info.width, height: info.height, color: [1, 1, 1, 1] } });
        aster.command({ type: 'toggleLayer', layerId: l.id, field: 'threeDimensional' });
        l.set({ position: [info.width / 2, info.height / 2, 1500] });
        const fit = l.fitToCamera({ margin: 20, samples: 4 });
        return { fit, scale: l.inspect(['transform.scale']) };
      `),
    );
    const data = result.result as {
      fit: { scaleMultiplier: number; applied: boolean };
      scale: { "transform.scale": Array<{ value: number }> };
    };
    expect(data.fit.applied).toBe(true);
    expect(data.fit.scaleMultiplier).toBeGreaterThan(1.5);
    expect(data.scale["transform.scale"][0].value).toBeCloseTo(100 * data.fit.scaleMultiplier, 3);
    expect(data.scale["transform.scale"][2].value).toBe(100);
  });

  it("suggests close effect names and lists valid parameters", async () => {
    await expect(
      executeScript(
        task(
          "const l = aster.compositions.active().layers.addText({text:'x'}); l.addEffect('blur');",
        ),
      ),
    ).rejects.toThrow(/Effect type does not exist: blur\. Did you mean: .*gaussian-blur/u);
    await expect(
      executeScript(
        task(
          "const l = aster.compositions.active().layers.addText({text:'x'}); l.addEffect('gaussian-blur', {amount: 3});",
        ),
      ),
    ).rejects.toThrow("Parameters: radius");
  });
});
