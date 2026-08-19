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
  palette: [string, string, string];
  effects: EffectPresetEntry[];
}

export const LOOK_PRESETS: EffectPreset[] = [
  {
    id: "cinematic-teal-amber",
    name: "Cinematic Teal & Amber",
    description: "Cool shadows, warm highlights, controlled saturation, and a soft film finish.",
    palette: ["#153f55", "#d48a45", "#f4d2a0"],
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
    palette: ["#22252a", "#85867f", "#d4c8ae"],
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
    palette: ["#15144d", "#138bd1", "#ec3fa9"],
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
    palette: ["#6d311b", "#dc8744", "#ffcf7a"],
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
    palette: ["#08090c", "#676b73", "#e4e5e2"],
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
    palette: ["#8d84b7", "#e3a9bc", "#f2dfc6"],
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
    palette: ["#071e3d", "#248ac0", "#eee0aa"],
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
    palette: ["#343943", "#adb5c1", "#f3f5f8"],
    effects: [
      { type: "levels", parameters: { inputBlack: 0.015, inputWhite: 0.985, gamma: 1.02 } },
      { type: "sharpen", parameters: { amount: 42, radius: 1, threshold: 2 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.04, pivot: 0.48, vibrance: 0.08, grain: 0, vignette: 0 },
      },
    ],
  },
  {
    id: "arctic-cyan",
    name: "Arctic Cyan",
    description: "Crisp cold daylight with cyan density and restrained, clean highlights.",
    palette: ["#082f4a", "#1d91a7", "#d8f5ed"],
    effects: [
      {
        type: "looks-color-lab",
        parameters: {
          temperature: -0.34,
          tint: -0.04,
          exposure: 0.08,
          contrast: 1.1,
          saturation: 0.92,
          vibrance: 0.12,
          vignette: 0.18,
        },
      },
      {
        type: "split-tone",
        parameters: {
          shadowHue: 210,
          shadowAmount: 0.15,
          highlightHue: 184,
          highlightAmount: 0.1,
        },
      },
    ],
  },
  {
    id: "sunset-emulsion",
    name: "Sunset Emulsion",
    description: "Warm tungsten stock, rose mids, and a broad amber halation shoulder.",
    palette: ["#61233d", "#d5634d", "#ffc06a"],
    effects: [
      {
        type: "film-emulation",
        parameters: { stock: 1, strength: 0.78, grain: 0.05, halation: 0.16 },
      },
      {
        type: "looks-color-lab",
        parameters: { temperature: 0.28, tint: 0.13, contrast: 1.12, fade: 0.04 },
      },
    ],
  },
  {
    id: "pastel-matte",
    name: "Pastel Matte",
    description: "Lifted shadows, compressed contrast, and a quiet pastel color envelope.",
    palette: ["#807b93", "#b6a8c4", "#e2cbbd"],
    effects: [
      {
        type: "looks-color-lab",
        parameters: {
          exposure: 0.28,
          contrast: 0.82,
          lift: 0.06,
          gain: 0.94,
          fade: 0.18,
          saturation: 0.78,
          bloom: 0.18,
          vignette: 0.08,
        },
      },
      {
        type: "split-tone",
        parameters: { shadowHue: 244, shadowAmount: 0.07, highlightHue: 24, highlightAmount: 0.09 },
      },
    ],
  },
  {
    id: "emerald-thriller",
    name: "Emerald Thriller",
    description: "Dense green shadows, muted skin-safe color, grain, and a hard vignette.",
    palette: ["#072f2b", "#34705b", "#b3a56c"],
    effects: [
      {
        type: "split-tone",
        parameters: { shadowHue: 158, shadowAmount: 0.22, highlightHue: 52, highlightAmount: 0.06 },
      },
      {
        type: "looks-color-lab",
        parameters: {
          temperature: -0.08,
          tint: -0.12,
          contrast: 1.3,
          saturation: 0.82,
          vignette: 0.42,
          grain: 0.05,
        },
      },
    ],
  },
  {
    id: "sepia-archive",
    name: "Sepia Archive",
    description: "Three-zone sepia mapping with tactile stock grain and subtle gate weave.",
    palette: ["#291b15", "#8a6748", "#ead9aa"],
    effects: [
      {
        type: "tritone",
        parameters: { shadows: 0x21150f, midtones: 0x8a6748, highlights: 0xead9aa, blend: 92 },
      },
      {
        type: "film-emulation",
        parameters: { stock: 0, strength: 0.55, grain: 0.12, halation: 0.04, weave: 0.8 },
      },
    ],
  },
  {
    id: "infrared-pop",
    name: "Infrared Pop",
    description: "False-color infrared mapping with electric foliage and luminous highlights.",
    palette: ["#110734", "#e81978", "#ffd54a"],
    effects: [
      { type: "colorama", parameters: { phase: 32, palette: 0, saturation: 1.25, blend: 72 } },
      { type: "glow", parameters: { threshold: 0.62, radius: 44, intensity: 0.55 } },
    ],
  },
  {
    id: "cyberpunk-split",
    name: "Cyberpunk Split",
    description: "Cyan shadows, magenta highlights, dense contrast, and neon bloom separation.",
    palette: ["#073b65", "#0bc5d9", "#ef2b9f"],
    effects: [
      {
        type: "split-tone",
        parameters: {
          shadowHue: 205,
          shadowAmount: 0.24,
          highlightHue: 322,
          highlightAmount: 0.25,
        },
      },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.2, saturation: 1.32, bloom: 0.68, vignette: 0.3 },
      },
    ],
  },
  {
    id: "soft-portrait",
    name: "Soft Portrait",
    description: "Warm, low-contrast portrait finish with gentle surface smoothing and bloom.",
    palette: ["#684c4f", "#c48f83", "#f0d0b7"],
    effects: [
      { type: "bilateral-blur", parameters: { radius: 2, threshold: 0.08 } },
      {
        type: "looks-color-lab",
        parameters: {
          temperature: 0.12,
          tint: 0.06,
          contrast: 0.94,
          pivot: 0.46,
          saturation: 0.96,
          vibrance: 0.08,
          lift: 0.025,
          bloom: 0.22,
          vignette: 0.12,
        },
      },
    ],
  },
  {
    id: "day-for-night",
    name: "Day for Night",
    description: "Underexposed moonlit blues with protected highlights and cool shadow density.",
    palette: ["#071426", "#164674", "#8db5c9"],
    effects: [
      {
        type: "white-balance",
        parameters: { temperature: -0.52, tint: -0.08, adaptation: 92 },
      },
      {
        type: "looks-color-lab",
        parameters: {
          exposure: -1.15,
          contrast: 1.26,
          pivot: 0.32,
          saturation: 0.68,
          lift: -0.025,
          vignette: 0.48,
          grain: 0.035,
        },
      },
      {
        type: "split-tone",
        parameters: {
          shadowHue: 222,
          shadowAmount: 0.24,
          highlightHue: 188,
          highlightAmount: 0.08,
        },
      },
    ],
  },
  {
    id: "sodium-vapor",
    name: "Sodium Vapor",
    description: "Monochromatic amber streetlight response with dense blacks and soft halation.",
    palette: ["#1b1005", "#a94f12", "#ffd36a"],
    effects: [
      {
        type: "tritone",
        parameters: { shadows: 0x140c05, midtones: 0xa94f12, highlights: 0xffd36a, blend: 96 },
      },
      { type: "glow", parameters: { threshold: 0.7, radius: 52, intensity: 0.65 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.28, pivot: 0.35, saturation: 0.58, vignette: 0.36 },
      },
    ],
  },
  {
    id: "vintage-print",
    name: "Vintage Print",
    description: "Warm print stock with faded blacks, tactile grain, and restrained color density.",
    palette: ["#3a2e2a", "#a47d63", "#e7c7a3"],
    effects: [
      {
        type: "film-emulation",
        parameters: { stock: 0, strength: 0.78, grain: 0.11, halation: 0.07, weave: 0.65 },
      },
      {
        type: "looks-color-lab",
        parameters: {
          temperature: 0.11,
          contrast: 0.92,
          lift: 0.045,
          gain: 0.93,
          fade: 0.13,
          saturation: 0.84,
          vignette: 0.22,
        },
      },
    ],
  },
  {
    id: "editorial-pop",
    name: "Editorial Pop",
    description: "Clean fashion contrast with precise reds, luminous neutrals, and polished color.",
    palette: ["#242630", "#df315f", "#f4e8dc"],
    effects: [
      {
        type: "selective-color",
        parameters: { target: 0, cyan: -12, magenta: 14, yellow: 6, black: -4, relative: 1 },
      },
      {
        type: "looks-color-lab",
        parameters: {
          exposure: 0.12,
          contrast: 1.14,
          pivot: 0.48,
          saturation: 1.08,
          vibrance: 0.16,
          bloom: 0.12,
        },
      },
      { type: "sharpen", parameters: { amount: 36, radius: 1.1, threshold: 3 } },
    ],
  },
  {
    id: "analog-vhs",
    name: "Analog VHS",
    description:
      "Late-eighties chroma separation, coarse color grain, faded density, and soft detail.",
    palette: ["#26265c", "#d33c8e", "#37bad1"],
    effects: [
      { type: "chromatic", parameters: { amount: 9, angle: 0, falloff: 0.45 } },
      {
        type: "add-grain",
        parameters: { intensity: 22, size: 2.4, softness: 0.12, colorAmount: 72, speed: 3.5 },
      },
      {
        type: "looks-color-lab",
        parameters: { contrast: 0.9, saturation: 1.12, fade: 0.14, gain: 0.92, vignette: 0.18 },
      },
    ],
  },
  {
    id: "nordic-clean",
    name: "Nordic Clean",
    description:
      "Neutral cool daylight, open whites, quiet saturation, and precise micro-contrast.",
    palette: ["#33434d", "#91aeb5", "#eff4ef"],
    effects: [
      { type: "white-balance", parameters: { temperature: -0.12, tint: -0.025, adaptation: 82 } },
      { type: "levels", parameters: { inputBlack: 0.01, inputWhite: 0.97, gamma: 1.04 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.04, pivot: 0.52, saturation: 0.88, vibrance: 0.07, bloom: 0.08 },
      },
    ],
  },
  {
    id: "crimson-thriller",
    name: "Crimson Thriller",
    description: "Cold cyan shadows against controlled crimson highlights and hard film density.",
    palette: ["#082b3a", "#7e1531", "#e64258"],
    effects: [
      {
        type: "split-tone",
        parameters: { shadowHue: 194, shadowAmount: 0.2, highlightHue: 352, highlightAmount: 0.23 },
      },
      {
        type: "selective-color",
        parameters: { target: 0, cyan: -18, magenta: 12, yellow: 5, black: 7, relative: 1 },
      },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.32, pivot: 0.37, saturation: 0.92, vignette: 0.44, grain: 0.055 },
      },
    ],
  },
  {
    id: "three-strip-color",
    name: "Three-Strip Color",
    description:
      "Dense primary separation inspired by three-strip print color and luminous skin tones.",
    palette: ["#153d5a", "#c3383f", "#e7b84c"],
    effects: [
      { type: "channel-mixer", parameters: { red: 1.1, green: 1.04, blue: 0.92, monochrome: 0 } },
      { type: "hue-saturation", parameters: { hue: -2, saturation: 1.14, lightness: 0.015 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.16, pivot: 0.43, vibrance: 0.18, bloom: 0.16, grain: 0.025 },
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
