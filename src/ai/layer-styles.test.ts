import { expect, it } from "vitest";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import { serializeProject, validateProjectDocument } from "../core/project/project-file";
import { BLEND_MODES } from "../core/types";
import { needsLayerIsolation } from "../renderer/compositing/layer-composite";
import { compileEffectProgram } from "../renderer/effects/effect-program";
import { normalizeAiCommands } from "./command-normalizer";

it("roundtrips all blend modes through the shared UI/MCP command path", () => {
  const source = createBlankProject(true);
  const layer = createLayerForComposition("text", source.compositions[0]);
  source.compositions[0].layers.push(layer);
  for (const blendMode of BLEND_MODES) {
    const { project } = normalizeAiCommands(
      [{ type: "setBlendMode", layerId: layer.id, blendMode }],
      source,
      0,
    );
    const saved = validateProjectDocument(JSON.parse(serializeProject(project)));
    const result = saved.compositions[0].layers.find((candidate) => candidate.id === layer.id);
    expect(result?.blendMode).toBe(blendMode);
    if (!result) throw new Error("Missing layer");
    expect(needsLayerIsolation(result)).toBe(!["normal", "add", "screen"].includes(blendMode));
  }
  expect(layer.blendMode).toBe("normal");
  expect(() =>
    normalizeAiCommands(
      [{ type: "setBlendMode", layerId: layer.id, blendMode: "unknown" }],
      source,
      0,
    ),
  ).toThrow();
});

it("preserves black style colors and scales soft edges without scaling spread or opacity", () => {
  const source = createBlankProject(true);
  const layer = createLayerForComposition("text", source.compositions[0]);
  source.compositions[0].layers.push(layer);
  const { project } = normalizeAiCommands(
    [
      {
        type: "addEffect",
        layerId: layer.id,
        effectType: "color-overlay",
        parameters: { color: 0xffffff, opacity: 100 },
      },
      {
        type: "addEffect",
        layerId: layer.id,
        effectType: "outer-glow",
        parameters: { color: 0, size: 8, opacity: 80, spread: 20 },
      },
      {
        type: "addEffect",
        layerId: layer.id,
        effectType: "drop-shadow",
        parameters: { color: 0, softness: 12, distance: 2, spread: 25 },
      },
    ],
    source,
    0,
  );
  const saved = validateProjectDocument(JSON.parse(serializeProject(project)));
  const result = saved.compositions[0].layers.find((candidate) => candidate.id === layer.id);
  if (!result) throw new Error("Missing layer");
  const full = compileEffectProgram(saved.compositions[0], 0, [result]);
  const half = compileEffectProgram(saved.compositions[0], 0, [result], 0.5);
  expect(full.count).toBe(3);
  expect([...full.data.slice(17, 20)]).toEqual([0, 0, 0]);
  expect(half.data[21]).toBe(full.data[21] / 2);
  expect(half.data[22]).toBe(full.data[22]);
  expect(half.data[38]).toBe(full.data[38] / 2);
  expect(half.data[39]).toBe(full.data[39] / 2);
  expect(half.data[40]).toBe(full.data[40]);
  expect(result.effects[2].parameters.spread).toBe(25);
});
