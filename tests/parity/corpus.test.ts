import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateProjectDocument } from "../../src/core/project/validation/document";
import { EFFECT_REGISTRY } from "../../src/effects/registry";
import { assertCaseStructure, assertCorpusCoverage } from "./coverage";
import { type ExampleShot, exampleCases, ownerCases } from "./external-cases";
import { buildGeneratedCases } from "./generators";
import type { ParityCase } from "./types";

const generated = buildGeneratedCases();
const corpus: { schemaVersion: number; cases: ParityCase[] } = JSON.parse(
  readFileSync(resolve("tests/parity/corpus.json"), "utf8"),
);

describe("migration corpus", () => {
  it("covers every live layer, blend, effect, AA and required feature with valid project structures", () => {
    expect(() => assertCorpusCoverage(generated)).not.toThrow();
    expect(corpus.schemaVersion).toBe(1);
    expect(new Set(corpus.cases.map((value) => value.id)).size).toBe(corpus.cases.length);
    expect(
      corpus.cases.filter((value) => generated.some((entry) => entry.case.id === value.id)),
    ).toEqual(generated.map((value) => value.case));
  });

  it("generates identical project bytes across fresh factory calls", () => {
    const digest = (input: unknown) =>
      createHash("sha256").update(JSON.stringify(input)).digest("hex");
    expect(digest(buildGeneratedCases())).toBe(digest(generated));
  });

  it.each(["layer:camera", "aa:ssaa4x", `effect:${EFFECT_REGISTRY[0].type}`])(
    "rejects removal of required coverage %s",
    (feature) => {
      const reduced = generated.filter((value) => !value.case.features.includes(feature));
      expect(() => assertCorpusCoverage(reduced)).toThrow(/Corpus coverage missing/);
    },
  );

  it("rejects feature labels when the corresponding active scene object is removed", () => {
    const value = structuredClone(
      generated.find((entry) => entry.case.features.includes("layer:camera")),
    );
    if (!value) throw new Error("Camera fixture missing");
    for (const composition of value.project.compositions)
      composition.layers = composition.layers.filter((layer) => layer.kind !== "camera");
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
  });

  it("rejects camera coverage outside the captured frames or hidden by a solo layer", () => {
    for (const hiddenBySolo of [false, true]) {
      const value = structuredClone(
        generated.find((entry) => entry.case.id === "scene-camera-perspective"),
      );
      if (!value) throw new Error("Camera fixture missing");
      value.case.features = ["layer:camera"];
      const composition = value.project.compositions[0];
      const camera = composition.layers.find((layer) => layer.kind === "camera");
      if (!camera) throw new Error("Camera layer missing");
      if (hiddenBySolo) {
        const shape = composition.layers.find((layer) => layer.kind === "shape");
        if (!shape) throw new Error("Camera subject missing");
        shape.solo = true;
      } else {
        camera.inPoint = 1.98;
        camera.outPoint = 2;
      }
      expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
    }
  });

  it("maps nested source time through stretch and remap before accepting feature coverage", () => {
    const value = structuredClone(
      generated.find((entry) => entry.case.id === "nested-precompositions"),
    );
    if (!value) throw new Error("Nested fixture missing");
    value.case.features = ["layer:shape"];
    value.case.frames = [30];
    const [root, middle, inner] = value.project.compositions;
    root.layers[0].timeStretch = 2;
    middle.layers[0].timeOffset = 0.25;
    inner.layers[0].inPoint = 0.7;
    inner.layers[0].outPoint = 0.8;
    expect(() => assertCaseStructure(value)).not.toThrow();
    root.layers[0].timeRemap = { mode: "static", value: 1 };
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
    root.layers[0].timeRemap = { mode: "static", value: 0.5 };
    expect(() => assertCaseStructure(value)).not.toThrow();
  });

  it("does not discard another instance of one precomposition evaluated at a different time", () => {
    const value = structuredClone(
      generated.find((entry) => entry.case.id === "nested-precompositions"),
    );
    if (!value) throw new Error("Nested fixture missing");
    value.case.features = ["layer:shape"];
    value.case.frames = [0];
    const [root, , inner] = value.project.compositions;
    const second = structuredClone(root.layers[0]);
    second.id = "second-time-instance";
    second.timeOffset = 1;
    root.layers.push(second);
    inner.layers[0].inPoint = 0.9;
    inner.layers[0].outPoint = 1.1;
    expect(() => assertCaseStructure(value)).not.toThrow();
    root.layers.pop();
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
  });

  it("rejects unobserved or muted audio sources despite their invisible audio layer", () => {
    const value = structuredClone(generated.find((entry) => entry.case.id === "media-audio"));
    if (!value) throw new Error("Audio fixture missing");
    value.case.features = ["layer:audio"];
    const audio = value.project.compositions[0].layers[0];
    expect(audio.visible).toBe(false);
    expect(() => assertCaseStructure(value)).not.toThrow();
    audio.inPoint = 1.98;
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
    audio.inPoint = 0;
    audio.audioEnabled = false;
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
  });

  it("rejects a trilinear resource mislabeled as tetrahedral coverage", () => {
    const value = structuredClone(generated.find((entry) => entry.case.id === "effect-lut"));
    if (!value) throw new Error("LUT fixture missing");
    value.case.features = ["lut:tetrahedral"];
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
  });

  it("rejects unknown feature claims instead of treating their labels as evidence", () => {
    const value = structuredClone(generated.find((entry) => entry.case.id === "layer-text"));
    if (!value) throw new Error("Text fixture missing");
    value.case.features = ["feature:missing-feature"];
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
  });

  it("rejects two sibling precompositions labeled as a nested composition chain", () => {
    const value = structuredClone(
      generated.find((entry) => entry.case.id === "nested-precompositions"),
    );
    if (!value) throw new Error("Nested fixture missing");
    value.case.features = ["feature:nested-precompositions"];
    const [root, middle, inner] = value.project.compositions;
    const sibling = structuredClone(root.layers[0]);
    sibling.id = "sibling-precomposition";
    sibling.sourceCompositionId = inner.id;
    root.layers.push(sibling);
    middle.layers = [];
    expect(() => assertCaseStructure(value)).toThrow(/has no active scene object/);
  });

  it("keeps owner sources external and pins a complete 300-frame main segment", () => {
    const owner = ownerCases();
    expect(corpus.cases.filter((value) => value.project === "env:ASTER_PERF_PROJECT")).toEqual(
      owner,
    );
    expect(owner[1].frames).toHaveLength(300);
    expect(owner[1].frames[0]).toBe(Math.max(...owner[0].frames) + 1);
    expect(owner[1].frames[owner[1].frames.length - 1]).toBe(owner[1].frames[0] + 299);
  });
});

describe("built-in example frame addresses", () => {
  let directory: string;
  let examples: ParityCase[];
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "aster-parity-example-"));
    execFileSync(process.execPath, ["examples/projects/enchanted-love/build.mjs", directory], {
      cwd: resolve("."),
      windowsHide: true,
      stdio: "pipe",
    });
    const project = validateProjectDocument(
      JSON.parse(readFileSync(join(directory, "project.json"), "utf8")),
    );
    const shots: ExampleShot[] = JSON.parse(readFileSync(join(directory, "shots.json"), "utf8"));
    examples = exampleCases(project, shots);
  });
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("preserves the golden manifest and samples the start, middle and end of every example shot", () => {
    expect(examples[0].frames).toEqual([0, 30, 60, 90, 119]);
    expect(examples[1].frames.length).toBeGreaterThan(100);
    expect(examples[1].frames[examples[1].frames.length - 1]).toBe(3902);
    expect(corpus.cases.slice(0, examples.length)).toEqual(examples);
  });
});
