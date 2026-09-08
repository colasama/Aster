import { evaluateAnimatable } from "../core/animation/timeline";
import type { Operation, PropertyPath } from "../core/editing/operations";
import { createLayerForComposition } from "../core/layers/layer-factory";
import type { Composition, Id, Layer } from "../core/types";
import { createId } from "../core/types";
import { createEffect } from "../effects/registry";

export const MAX_LOCAL_AI_OPERATIONS = 12;

export interface LocalAiPlan {
  summary: string;
  operations: Operation[];
}

export function planLocalAiOperations(
  intent: string,
  composition: Composition,
  selectedLayerIds: readonly Id[],
  currentTime: number,
): LocalAiPlan {
  const prompt = intent.trim();
  const lowered = prompt.toLocaleLowerCase();
  const selected = selectedLayers(composition, selectedLayerIds);

  if (matches(lowered, ["减少弹性", "reduce elasticity", "less bouncy", "less springy"])) {
    return bounded(
      prompt,
      selected.map((layer) => ({ type: "easeLayer", layerId: layer.id })),
    );
  }

  if (matches(lowered, ["景深", "depth of field", "background dof"])) {
    const subjectIds = new Set(selected.map((layer) => layer.id));
    const backgrounds = composition.layers.filter(
      (layer) =>
        layer.visible &&
        !subjectIds.has(layer.id) &&
        layer.kind !== "camera" &&
        layer.kind !== "light",
    );
    return bounded(
      prompt,
      backgrounds.map((layer) => {
        const effect = createEffect("camera-lens-blur");
        effect.name = "AI Background Depth of Field";
        effect.parameters.radius = 28;
        effect.parameters.highlightGain = 1.4;
        return { type: "addEffect", layerId: layer.id, effect };
      }),
    );
  }

  if (
    matches(lowered, ["复制", "duplicate"]) &&
    matches(lowered, ["交替", "alternate", "alternating"])
  ) {
    return bounded(prompt, duplicateWithAlternatingEntry(selected, currentTime));
  }

  if (matches(lowered, ["glow", "发光", "辉光"])) {
    return bounded(
      prompt,
      selected.map((layer) => {
        const effect = createEffect("glow");
        effect.name = "AI Glow";
        effect.parameters.radius = 64;
        effect.parameters.intensity = 1.35;
        return { type: "addEffect", layerId: layer.id, effect };
      }),
    );
  }

  if (matches(lowered, ["stagger", "错开", "依次"])) {
    return bounded(
      prompt,
      selected.map((layer, index) => ({
        type: "setLayerTiming",
        layerId: layer.id,
        inPoint: layer.inPoint + index * 0.08,
        outPoint: layer.outPoint + index * 0.08,
      })),
    );
  }

  if (matches(lowered, ["文字图层", "text layer", "add text", "create text"])) {
    const layer = createLayerForComposition("text", composition, currentTime);
    layer.name = "AI Text";
    layer.text = quotedText(prompt) ?? "Text";
    return bounded(prompt, [{ type: "addLayer", layer }]);
  }

  const layer = selected[0];
  if (!layer) return { summary: prompt || "No editable target", operations: [] };
  const end = evaluateAnimatable(layer.transform.position[1], currentTime);
  const offset = Math.min(420, composition.height * 0.3);
  return bounded(prompt || "Animate selected layer", [
    keyframe(layer.id, "position.1", currentTime, end + offset),
    keyframe(layer.id, "position.1", currentTime + 0.9, end),
  ]);
}

function duplicateWithAlternatingEntry(layers: readonly Layer[], currentTime: number): Operation[] {
  const operations: Operation[] = [];
  for (const [index, source] of layers.slice(0, 4).entries()) {
    const layer = cloneLayer(source);
    const targetX = evaluateAnimatable(source.transform.position[0], currentTime);
    const targetY = evaluateAnimatable(source.transform.position[1], currentTime);
    layer.transform.position[0] = { mode: "static", value: targetX };
    layer.transform.position[1] = { mode: "static", value: targetY };
    operations.push(
      { type: "addLayer", layer },
      keyframe(
        layer.id,
        "position.0",
        currentTime + index * 0.08,
        targetX + (index % 2 ? 240 : -240),
      ),
      keyframe(layer.id, "position.0", currentTime + index * 0.08 + 0.65, targetX),
    );
  }
  return operations;
}

function cloneLayer(source: Layer): Layer {
  const layer = structuredClone(source);
  layer.id = createId();
  layer.name = `${source.name} Copy`;
  for (const effect of layer.effects) {
    effect.id = createId();
    for (const keyframes of Object.values(effect.parameterKeyframes ?? {}))
      for (const keyframe of keyframes) keyframe.id = createId();
  }
  return layer;
}

function keyframe(layerId: Id, path: PropertyPath, time: number, value: number): Operation {
  return {
    type: "addKeyframe",
    layerId,
    path,
    keyframe: {
      id: createId(),
      time: Math.max(0, time),
      value,
      interpolation: "bezier",
      easing: [0.16, 1, 0.3, 1],
    },
  };
}

function selectedLayers(composition: Composition, ids: readonly Id[]): Layer[] {
  const selected = new Set(ids.slice(0, 16));
  return composition.layers.filter((layer) => selected.has(layer.id) && !layer.locked);
}

function matches(prompt: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => prompt.includes(phrase));
}

function quotedText(prompt: string): string | undefined {
  const match = prompt.match(/[“"']([^”"']{1,256})[”"']/u);
  return match?.[1].trim() || undefined;
}

function bounded(summary: string, operations: Operation[]): LocalAiPlan {
  return {
    summary: summary || "Structured local operation plan",
    operations: operations.slice(0, MAX_LOCAL_AI_OPERATIONS),
  };
}
