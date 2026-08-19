import type { Effect } from "../core/types";
import { createEffect, EFFECT_BY_TYPE } from "./registry";

export interface EffectPresetEntry {
  type: string;
  parameters?: Record<string, number>;
}

export interface EffectPreset {
  id: string;
  name: string;
  description: string;
  effects: EffectPresetEntry[];
}

export const LOOK_PRESETS: EffectPreset[] = [
  {
    id: "cinematic-teal-amber",
    name: "Cinematic Teal & Amber",
    description: "Cool shadows, warm highlights, controlled saturation, and a soft film finish.",
    effects: [
      {
        type: "looks-color-lab",
        parameters: {
          contrast: 1.18,
          pivot: 0.4,
          saturation: 0.92,
          vibrance: 0.18,
          vignette: 0.24,
        },
      },
      {
        type: "split-tone",
        parameters: { shadowHue: 202, shadowAmount: 0.18, highlightHue: 34, highlightAmount: 0.14 },
      },
    ],
  },
  {
    id: "bleach-bypass",
    name: "Bleach Bypass",
    description: "Dense contrast, restrained color, silver grain, and subtle halation.",
    effects: [
      {
        type: "film-emulation",
        parameters: { stock: 3, strength: 0.85, grain: 0.09, halation: 0.08 },
      },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.24, pivot: 0.38, saturation: 0.72, fade: 0.02 },
      },
    ],
  },
  {
    id: "neon-night",
    name: "Neon Night",
    description: "Cool neon color separation with lifted bloom and deep edge focus.",
    effects: [
      {
        type: "looks-color-lab",
        parameters: {
          temperature: -0.16,
          tint: 0.12,
          exposure: 0.2,
          contrast: 1.14,
          saturation: 1.24,
          vibrance: 0.28,
          bloom: 0.85,
          vignette: 0.34,
        },
      },
      {
        type: "split-tone",
        parameters: {
          shadowHue: 238,
          shadowAmount: 0.16,
          highlightHue: 318,
          highlightAmount: 0.12,
        },
      },
    ],
  },
  {
    id: "golden-hour",
    name: "Golden Hour",
    description: "Warm filmic highlights with gentle contrast and low-density bloom.",
    effects: [
      {
        type: "looks-color-lab",
        parameters: {
          temperature: 0.32,
          tint: 0.06,
          exposure: 0.18,
          contrast: 1.06,
          saturation: 1.08,
          bloom: 0.28,
        },
      },
      {
        type: "split-tone",
        parameters: { shadowHue: 224, shadowAmount: 0.06, highlightHue: 35, highlightAmount: 0.2 },
      },
    ],
  },
  {
    id: "monochrome-noir",
    name: "Monochrome Noir",
    description: "Channel-shaped monochrome with a hard toe, grain, and vignette.",
    effects: [
      { type: "black-white", parameters: { reds: 0.38, greens: 0.52, blues: 0.1 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.36, pivot: 0.36, lift: -0.025, grain: 0.075, vignette: 0.42 },
      },
    ],
  },
  {
    id: "dream-bloom",
    name: "Dream Bloom",
    description: "Soft high-key fade with warm bloom and a restrained pastel palette.",
    effects: [
      { type: "glow", parameters: { threshold: 0.58, radius: 72, intensity: 0.85 } },
      {
        type: "looks-color-lab",
        parameters: {
          exposure: 0.22,
          contrast: 0.94,
          saturation: 0.9,
          fade: 0.1,
          temperature: 0.1,
        },
      },
    ],
  },
  {
    id: "reversal-chrome",
    name: "Reversal Chrome",
    description: "Crisp saturated reversal stock with clean blacks and cool density.",
    effects: [
      {
        type: "film-emulation",
        parameters: { stock: 2, strength: 0.72, grain: 0.035, halation: 0.06 },
      },
      {
        type: "looks-color-lab",
        parameters: {
          temperature: -0.04,
          contrast: 1.16,
          pivot: 0.44,
          saturation: 1.15,
          gain: 1.04,
        },
      },
    ],
  },
  {
    id: "clean-product",
    name: "Clean Product",
    description: "Neutral product finish with precise levels, micro-contrast, and sharpening.",
    effects: [
      { type: "levels", parameters: { inputBlack: 0.015, inputWhite: 0.985, gamma: 1.02 } },
      { type: "sharpen", parameters: { amount: 42, radius: 1, threshold: 2 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.04, pivot: 0.48, vibrance: 0.08, grain: 0, vignette: 0 },
      },
    ],
  },
];

export function createEffectsFromPreset(preset: EffectPreset): Effect[] {
  return preset.effects.map((entry) => {
    const definition = EFFECT_BY_TYPE.get(entry.type);
    if (!definition) throw new Error(`Unknown preset effect: ${entry.type}`);
    const effect = createEffect(entry.type);
    for (const [key, requested] of Object.entries(entry.parameters ?? {})) {
      const parameter = definition.parameters.find((candidate) => candidate.key === key);
      if (!parameter) throw new Error(`Unknown preset parameter: ${entry.type}.${key}`);
      effect.parameters[key] = clamp(requested, parameter.min, parameter.max);
    }
    return effect;
  });
}

function clamp(value: number, minimum?: number, maximum?: number): number {
  if (!Number.isFinite(value)) throw new Error("Preset parameters must be finite");
  return Math.max(minimum ?? -Infinity, Math.min(maximum ?? Infinity, value));
}
