import { choice, number, percent, toggle } from "./parameter-builders";
import type { EffectDefinition } from "./types";

export const AE_NOISE_GRAIN_EFFECTS: EffectDefinition[] = [
  {
    type: "add-grain",
    name: "Add Grain",
    category: "Noise & Grain",
    description:
      "Add deterministic, size-aware monochrome or chromatic film grain by tonal region.",
    execution: "fused-pixel",
    parameters: [
      percent("intensity", "Intensity", 18),
      number("size", "Size", 1.4, 0.25, 32, 0.05, "px"),
      number("softness", "Softness", 0.35, 0, 1, 0.01),
      percent("colorAmount", "Color Amount", 20),
      percent("shadows", "Shadow Grain", 100),
      percent("midtones", "Midtone Grain", 75),
      percent("highlights", "Highlight Grain", 45),
      number("speed", "Animation Speed", 1, 0, 20, 0.1),
    ],
  },
  {
    type: "dust-scratches",
    name: "Dust & Scratches",
    category: "Noise & Grain",
    description:
      "Replace isolated high-frequency defects while preserving broader image structure.",
    execution: "multi-pass",
    parameters: [
      number("radius", "Radius", 3, 0.5, 128, 0.5, "px"),
      number("threshold", "Threshold", 0.12, 0, 1, 0.005),
      number("softness", "Softness", 0.04, 0, 1, 0.005),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "median",
    name: "Median",
    category: "Noise & Grain",
    description: "Suppress impulse noise with a five-sample median filter.",
    execution: "multi-pass",
    parameters: [
      number("radius", "Radius", 2, 0.5, 128, 0.5, "px"),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "noise-alpha",
    name: "Noise Alpha",
    category: "Noise & Grain",
    description: "Perturb source alpha with deterministic additive or multiplicative noise.",
    execution: "fused-pixel",
    parameters: [
      percent("amount", "Amount", 12),
      choice("mode", "Operation", ["Add", "Multiply", "Replace"]),
      number("size", "Noise Size", 1, 0.25, 64, 0.25, "px"),
      number("speed", "Animation Speed", 1, 0, 20, 0.1),
      toggle("clip", "Clip Result", 1),
    ],
  },
  {
    type: "noise-hls",
    name: "Noise HLS",
    category: "Noise & Grain",
    description: "Add independent deterministic hue, lightness, and saturation noise.",
    execution: "fused-pixel",
    parameters: [
      number("hue", "Hue Noise", 8, 0, 180, 0.5, "°"),
      percent("lightness", "Lightness Noise", 8),
      percent("saturation", "Saturation Noise", 12),
      number("size", "Noise Size", 1, 0.25, 64, 0.25, "px"),
      number("phase", "Noise Phase", 0, -1000, 1000, 0.1),
    ],
  },
  {
    type: "noise-hls-auto",
    name: "Noise HLS Auto",
    category: "Noise & Grain",
    description: "Animate balanced HLS noise automatically with a deterministic timeline seed.",
    execution: "fused-pixel",
    parameters: [
      percent("amount", "Noise Amount", 12),
      percent("colorAmount", "Color Amount", 35),
      number("size", "Noise Size", 1, 0.25, 64, 0.25, "px"),
      number("speed", "Noise Speed", 2, 0, 30, 0.1),
      number("seed", "Random Seed", 1, 0, 65535, 1),
    ],
  },
  {
    type: "remove-grain",
    name: "Remove Grain",
    category: "Noise & Grain",
    description: "Reduce fine stochastic grain while retaining edges above a detail threshold.",
    execution: "multi-pass",
    parameters: [
      number("radius", "Noise Reduction Radius", 2.5, 0.5, 128, 0.5, "px"),
      number("threshold", "Detail Threshold", 0.1, 0, 1, 0.005),
      number("softness", "Edge Softness", 0.08, 0, 1, 0.005),
      percent("strength", "Reduction Strength", 75),
    ],
  },
  {
    type: "turbulent-noise",
    name: "Turbulent Noise",
    category: "Noise & Grain",
    description: "Generate animated fractal turbulence and composite it using common blend modes.",
    execution: "compute",
    parameters: [
      choice("type", "Noise Type", ["Basic", "Turbulent", "Dynamic"]),
      number("contrast", "Contrast", 1.4, 0, 8, 0.01),
      number("brightness", "Brightness", 0, -1, 1, 0.01),
      number("scale", "Scale", 180, 1, 4000, 1, "px"),
      number("evolution", "Evolution", 0, -1000, 1000, 0.1),
      percent("opacity", "Opacity", 65),
      choice("blendMode", "Blend Mode", ["Normal", "Overlay", "Add", "Multiply"]),
    ],
  },
];
