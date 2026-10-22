import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function prepareTextBlurFixtures(context) {
  const local = (p) => relative(context.root, p).replaceAll("\\", "/"),
    corpus = await readFile(join(context.root, "tests/parity/corpus.json")),
    template = JSON.parse(corpus).cases.find((c) => c.id === "scene-motion-blur"),
    original = await readFile(join(context.root, template.project)),
    fontPath = join(context.env.SystemRoot ?? "C:/Windows", "Fonts/tahoma.ttf"),
    font = { path: fontPath, sha256: sha256(await readFile(fontPath)) },
    scalar = (value) => ({ mode: "static", value }),
    animated = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 0, interpolation: "linear" },
        { id: "end", time: 1, value: 6, interpolation: "linear" },
      ],
    },
    selector = {
      id: "selector",
      name: "Selector",
      enabled: true,
      kind: "range",
      mode: "add",
      amount: scalar(100),
      basedOn: "characters",
      units: "percentage",
      start: scalar(0),
      end: scalar(100),
      offset: scalar(0),
      shape: "square",
      smoothness: scalar(0),
      easeLow: scalar(0),
      easeHigh: scalar(0),
      randomizeOrder: false,
      randomSeed: 0,
    },
    controls = [
      { id: "nonzero", blur: scalar(4) },
      { id: "zero", blur: scalar(0) },
      { id: "disabled-group", blur: scalar(4), group: false },
      { id: "disabled-animator", blur: scalar(4), enabled: false },
      { id: "unselected", blur: scalar(4), amount: 0 },
      { id: "time-varying", blur: animated },
      { id: "wrapped-selection", blur: scalar(4), wrapped: true },
      { id: "below-threshold", blur: scalar(0.0000001) },
    ],
    manifest = {
      scope: "evaluated-character-blur-v1",
      font,
      template: { path: template.project, sha256: sha256(original), corpus_sha256: sha256(corpus) },
      cases: [],
    };
  for (const temporal of [false, true]) {
    const project = JSON.parse(original),
      composition = project.compositions.find((c) => c.id === template.composition),
      base = composition.layers.find((l) => l.kind === "text"),
      id = temporal ? "text-blur-exposure" : "text-blur-controls",
      specs = temporal ? [{ id: "exposure", blur: animated }] : controls;
    assert(base && project.sources.length === 0);
    project.fonts = [];
    composition.layers = specs.map((spec) => {
      const layer = structuredClone(base),
        range = structuredClone(selector);
      layer.id = `blur-${spec.id}`;
      layer.text = spec.wrapped ? "AB CD EF GH" : "AB CD";
      layer.motionBlur = temporal;
      if (spec.wrapped) {
        layer.size = [58, 120];
        range.basedOn = "lines";
        range.units = "index";
        range.start = scalar(1);
        range.end = scalar(2);
      }
      if (spec.amount !== undefined) range.amount = scalar(spec.amount);
      layer.textStyle = {
        ...layer.textStyle,
        fontFamily: "Tahoma",
        fontWeight: 400,
        fontSize: 24,
        tracking: 0,
        strokeWidth: 0,
      };
      layer.textAnimator = {
        enabled: spec.enabled !== false,
        groups: [
          {
            id: "group",
            name: "Blur",
            enabled: spec.group !== false,
            randomSeed: 0,
            selectors: [range],
            properties: { blur: [structuredClone(spec.blur), scalar(0)] },
          },
        ],
      };
      return layer;
    });
    if (!temporal) composition.motionBlur.enabled = false;
    const path = join(context.output, id, "project.json"),
      raw = `${JSON.stringify(project, null, 2)}\n`;
    await mkdir(join(context.output, id), { recursive: true });
    await writeFile(path, raw, { flag: "wx" });
    manifest.cases.push({
      ...template,
      id,
      project: local(path),
      project_sha256: sha256(raw),
      frames: [0, 15, 30],
      temporal,
      layers: specs.map((s) => ({ id: `blur-${s.id}`, control: s.id })),
    });
  }
  const path = join(context.output, "manifest.json");
  await writeAtomicJson(path, manifest);
  return { path, manifest };
}
